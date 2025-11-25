import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import winston from 'winston';
import os from 'os';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [PROCESS-MANAGER-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Cross-platform process manager for spawning and managing long-running processes
 * Provides similar functionality to the C# PowerShellCommandManager
 */
class ProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.processId = options.processId || `process_${Date.now()}`;
    this.command = null;
    this.args = [];
    this.options = {};
    this.process = null;
    this.isRunning = false;
    this.startTime = null;
    this.restartCount = 0;
    this.maxRestarts = options.maxRestarts || 5;
    this.restartDelay = options.restartDelay || 5000;
    this.monitorInterval = options.monitorInterval || 10000;
    this.monitorTimer = null;
    this.autoRestart = options.autoRestart || false;

    // Output buffers
    this.outputBuffer = [];
    this.errorBuffer = [];
    this.maxBufferSize = options.maxBufferSize || 1000;

    // Platform detection
    this.platform = os.platform();
    this.isWindows = this.platform === 'win32';

    logger.info(`Process Manager initialized for ${this.processId} on ${this.platform}`);
  }

  /**
   * Configure the command to run
   */
  setCommand(command, args = [], options = {}) {
    if (this.isRunning) {
      throw new Error('Cannot set command while process is running. Stop the process first.');
    }

    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.options = {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      ...options
    };

    logger.info(`Command configured: ${command} ${this.args.join(' ')}`);
  }

  /**
   * Set PowerShell command (Windows only)
   */
  setPowerShellCommand(psCommand, options = {}) {
    if (!this.isWindows) {
      logger.warn('PowerShell command set on non-Windows platform, using shell instead');
      return this.setShellCommand(psCommand, options);
    }

    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', psCommand
    ];

    this.setCommand('powershell.exe', args, options);
  }

  /**
   * Set shell command (cross-platform)
   */
  setShellCommand(shellCommand, options = {}) {
    const shell = this.isWindows ? 'cmd.exe' : '/bin/bash';
    const args = this.isWindows ? ['/c', shellCommand] : ['-c', shellCommand];

    this.setCommand(shell, args, options);
  }

  /**
   * Start the process
   */
  start() {
    if (this.isRunning) {
      logger.warn(`Process ${this.processId} is already running`);
      return false;
    }

    if (!this.command) {
      const error = 'No command configured. Use setCommand(), setPowerShellCommand(), or setShellCommand() first.';
      logger.error(error);
      this.emit('error', new Error(error));
      return false;
    }

    try {
      logger.info(`Starting process ${this.processId}: ${this.command} ${this.args.join(' ')}`);

      this.process = spawn(this.command, this.args, this.options);
      this.isRunning = true;
      this.startTime = new Date();

      // Setup event handlers
      this.setupProcessHandlers();

      // Start monitoring
      this.startMonitoring();

      this.emit('started', {
        processId: this.processId,
        pid: this.process.pid,
        startTime: this.startTime
      });

      logger.info(`Process ${this.processId} started with PID ${this.process.pid}`);
      return true;

    } catch (error) {
      logger.error(`Failed to start process ${this.processId}: ${error.message}`);
      this.isRunning = false;
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Setup process event handlers
   */
  setupProcessHandlers() {
    if (!this.process) return;

    // Handle stdout
    if (this.process.stdout) {
      this.process.stdout.on('data', (data) => {
        const output = data.toString();
        this.addToBuffer(this.outputBuffer, output);
        this.emit('stdout', output);
        logger.debug(`${this.processId} stdout: ${output.trim()}`);
      });
    }

    // Handle stderr
    if (this.process.stderr) {
      this.process.stderr.on('data', (data) => {
        const error = data.toString();
        this.addToBuffer(this.errorBuffer, error);
        this.emit('stderr', error);
        logger.debug(`${this.processId} stderr: ${error.trim()}`);
      });
    }

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      logger.info(`Process ${this.processId} exited with code ${code}, signal ${signal}`);
      this.isRunning = false;
      this.stopMonitoring();

      const exitInfo = {
        processId: this.processId,
        code,
        signal,
        uptime: this.getUptime()
      };

      this.emit('exit', exitInfo);

      // Handle auto-restart
      if (this.autoRestart && this.restartCount < this.maxRestarts) {
        logger.info(`Auto-restarting ${this.processId} in ${this.restartDelay}ms (attempt ${this.restartCount + 1}/${this.maxRestarts})`);
        setTimeout(() => {
          this.restartCount++;
          this.start();
        }, this.restartDelay);
      } else if (this.restartCount >= this.maxRestarts) {
        logger.error(`Process ${this.processId} exceeded max restart attempts (${this.maxRestarts})`);
        this.emit('maxRestartsReached', exitInfo);
      }
    });

    // Handle process errors
    this.process.on('error', (error) => {
      logger.error(`Process ${this.processId} error: ${error.message}`);
      this.isRunning = false;
      this.emit('error', error);
    });
  }

  /**
   * Stop the process
   */
  stop(force = false) {
    if (!this.isRunning || !this.process) {
      logger.warn(`Process ${this.processId} is not running`);
      return false;
    }

    try {
      logger.info(`Stopping process ${this.processId}${force ? ' (forced)' : ''}`);

      this.stopMonitoring();
      this.autoRestart = false; // Disable auto-restart when manually stopping

      if (force) {
        this.process.kill('SIGKILL');
      } else {
        this.process.kill('SIGTERM');

        // Force kill after timeout if process doesn't exit gracefully
        setTimeout(() => {
          if (this.isRunning && this.process) {
            logger.warn(`Process ${this.processId} did not exit gracefully, force killing`);
            this.process.kill('SIGKILL');
          }
        }, 5000);
      }

      return true;
    } catch (error) {
      logger.error(`Failed to stop process ${this.processId}: ${error.message}`);
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Restart the process
   */
  restart() {
    logger.info(`Restarting process ${this.processId}`);

    if (this.isRunning) {
      this.once('exit', () => {
        setTimeout(() => {
          this.start();
        }, 1000);
      });
      this.stop();
    } else {
      this.start();
    }
  }

  /**
   * Start process monitoring
   */
  startMonitoring() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
    }

    this.monitorTimer = setInterval(() => {
      this.checkProcessHealth();
    }, this.monitorInterval);
  }

  /**
   * Stop process monitoring
   */
  stopMonitoring() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  /**
   * Check process health
   */
  checkProcessHealth() {
    const status = this.getStatus();
    this.emit('healthCheck', status);

    if (!this.isRunning && this.autoRestart && this.restartCount < this.maxRestarts) {
      logger.info(`Health check detected stopped process, auto-restarting ${this.processId}`);
      this.restartCount++;
      this.start();
    }
  }

  /**
   * Get process status
   */
  getStatus() {
    return {
      processId: this.processId,
      isRunning: this.isRunning,
      pid: this.process?.pid || null,
      startTime: this.startTime,
      uptime: this.getUptime(),
      restartCount: this.restartCount,
      command: this.command,
      args: this.args,
      platform: this.platform
    };
  }

  /**
   * Get process uptime in milliseconds
   */
  getUptime() {
    return this.startTime ? Date.now() - this.startTime.getTime() : 0;
  }

  /**
   * Get recent output
   */
  getOutput(lines = 50) {
    return this.outputBuffer.slice(-lines).join('');
  }

  /**
   * Get recent errors
   */
  getErrors(lines = 50) {
    return this.errorBuffer.slice(-lines).join('');
  }

  /**
   * Clear output buffers
   */
  clearBuffers() {
    this.outputBuffer = [];
    this.errorBuffer = [];
  }

  /**
   * Add data to buffer with size limit
   */
  addToBuffer(buffer, data) {
    buffer.push(data);
    if (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }
  }

  /**
   * Enable auto-restart
   */
  enableAutoRestart(maxRestarts = 5, restartDelay = 5000) {
    this.autoRestart = true;
    this.maxRestarts = maxRestarts;
    this.restartDelay = restartDelay;
    this.restartCount = 0;
    logger.info(`Auto-restart enabled for ${this.processId} (max: ${maxRestarts}, delay: ${restartDelay}ms)`);
  }

  /**
   * Disable auto-restart
   */
  disableAutoRestart() {
    this.autoRestart = false;
    logger.info(`Auto-restart disabled for ${this.processId}`);
  }

  /**
   * Cleanup and dispose
   */
  dispose() {
    logger.info(`Disposing process manager for ${this.processId}`);

    this.disableAutoRestart();
    this.stopMonitoring();

    if (this.isRunning) {
      this.stop(true); // Force stop
    }

    this.removeAllListeners();
    this.clearBuffers();
  }
}

export default ProcessManager;