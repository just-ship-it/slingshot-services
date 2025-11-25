import { EventEmitter } from 'events';
import ProcessManager from './processManager.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [WEBHOOK-RELAY-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Webhook Relay Service
 * Manages the webhookrelay.com tunnel process for receiving external webhooks locally
 */
class WebhookRelayService extends EventEmitter {
  constructor() {
    super();

    // Configuration from environment variables
    this.relayName = process.env.WEBHOOK_RELAY_NAME || 'slingshot';
    this.destination = process.env.WEBHOOK_RELAY_DESTINATION || 'http://172.29.244.52:3010/slingshot';
    this.relayCommand = process.env.WEBHOOK_RELAY_COMMAND || 'relay';
    this.autoStart = process.env.WEBHOOK_RELAY_AUTO_START !== 'false';
    this.autoRestart = process.env.WEBHOOK_RELAY_AUTO_RESTART !== 'false';

    // Process manager
    this.processManager = new ProcessManager({
      processId: 'webhook-relay',
      autoRestart: this.autoRestart,
      maxRestarts: 10,
      restartDelay: 10000,
      monitorInterval: 15000
    });

    // State tracking
    this.isInitialized = false;
    this.connectionUrl = null;
    this.lastError = null;
    this.startAttempts = 0;
    this.maxStartAttempts = 3;

    // Setup process event handlers
    this.setupEventHandlers();

    logger.info('Webhook Relay Service initialized');
    logger.info(`Configuration: relay=${this.relayName}, destination=${this.destination}`);
  }

  /**
   * Setup event handlers for the process manager
   */
  setupEventHandlers() {
    this.processManager.on('started', (info) => {
      logger.info(`Webhook relay started: PID ${info.pid}`);
      this.lastError = null;
      this.emit('started', info);
    });

    this.processManager.on('stdout', (data) => {
      this.parseRelayOutput(data);
      // Filter out HTTP request logs before emitting
      const filteredData = this.filterHttpRequestLogs(data);
      if (filteredData) {
        this.emit('output', { type: 'stdout', data: filteredData });
      }
    });

    this.processManager.on('stderr', (data) => {
      this.parseRelayError(data);
      this.emit('output', { type: 'stderr', data });
    });

    this.processManager.on('exit', (info) => {
      logger.warn(`Webhook relay exited: code ${info.code}, signal ${info.signal}`);
      this.connectionUrl = null;
      this.emit('exit', info);

      // Reset start attempts on successful run (uptime > 30 seconds)
      if (info.uptime > 30000) {
        this.startAttempts = 0;
      }
    });

    this.processManager.on('error', (error) => {
      logger.error(`Webhook relay error: ${error.message}`);
      this.lastError = error.message;
      this.emit('error', error);
    });

    this.processManager.on('healthCheck', (status) => {
      this.emit('healthCheck', status);
    });

    this.processManager.on('maxRestartsReached', (info) => {
      logger.error('Webhook relay exceeded maximum restart attempts');
      this.lastError = 'Maximum restart attempts exceeded';
      this.emit('maxRestartsReached', info);
    });
  }

  /**
   * Filter out HTTP request logs from relay output
   */
  filterHttpRequestLogs(data) {
    const output = data.toString();
    const lines = output.split('\n');

    // Filter out lines containing HTTP request logs
    const filteredLines = lines.filter(line => {
      // Remove lines containing HTTP request information
      if (line.includes('HTTP request') &&
          line.includes('protocol') &&
          line.includes('path') &&
          line.includes('method') &&
          line.includes('status') &&
          line.includes('duration')) {
        return false;
      }
      return line.trim() !== '';
    });

    // Return filtered output or null if no content remains
    return filteredLines.length > 0 ? filteredLines.join('\n') : null;
  }

  /**
   * Parse relay output to extract connection information
   */
  parseRelayOutput(data) {
    const output = data.toString().trim();

    // Look for webhook URL in the output
    const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.hook\.events/);
    if (urlMatch) {
      this.connectionUrl = urlMatch[0];
      logger.info(`Webhook relay URL detected: ${this.connectionUrl}`);
      this.emit('urlDetected', this.connectionUrl);
    }

    // Look for connection status
    if (output.includes('connected') || output.includes('Connected')) {
      logger.info('Webhook relay connected successfully');
      this.emit('connected');
    }

    // Look for authentication success
    if (output.includes('authenticated') || output.includes('Authentication successful')) {
      logger.info('Webhook relay authenticated');
      this.emit('authenticated');
    }
  }

  /**
   * Parse relay error output
   */
  parseRelayError(data) {
    const error = data.toString().trim();

    // Check for common error patterns
    if (error.includes('authentication failed') || error.includes('Unauthorized')) {
      this.lastError = 'Authentication failed - check relay credentials';
      logger.error('Webhook relay authentication failed');
      this.emit('authenticationFailed');
    } else if (error.includes('connection failed') || error.includes('dial tcp')) {
      this.lastError = 'Connection failed - check network connectivity';
      logger.error('Webhook relay connection failed');
      this.emit('connectionFailed');
    } else if (error.includes('command not found') || error.includes('not recognized')) {
      this.lastError = 'Relay command not found - ensure webhookrelay CLI is installed';
      logger.error('Webhook relay CLI not found');
      this.emit('commandNotFound');
    } else if (error.trim()) {
      this.lastError = error;
      logger.warn(`Webhook relay warning: ${error}`);
    }
  }

  /**
   * Start the webhook relay
   */
  async start() {
    if (this.processManager.isRunning) {
      logger.warn('Webhook relay is already running');
      return { success: false, message: 'Already running' };
    }

    if (this.startAttempts >= this.maxStartAttempts) {
      const message = `Maximum start attempts (${this.maxStartAttempts}) reached`;
      logger.error(message);
      return { success: false, message };
    }

    try {
      this.startAttempts++;
      logger.info(`Starting webhook relay (attempt ${this.startAttempts}/${this.maxStartAttempts})`);

      // Build the relay command
      const relayArgs = ['connect', '--name', this.relayName, '--destination', this.destination];

      // Add authentication if available
      if (process.env.WEBHOOK_RELAY_KEY) {
        relayArgs.push('--key', process.env.WEBHOOK_RELAY_KEY);
      }
      if (process.env.WEBHOOK_RELAY_SECRET) {
        relayArgs.push('--secret', process.env.WEBHOOK_RELAY_SECRET);
      }

      // Configure the process
      this.processManager.setCommand(this.relayCommand, relayArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      // Enable auto-restart if configured
      if (this.autoRestart) {
        this.processManager.enableAutoRestart(10, 10000);
      }

      // Start the process
      const started = this.processManager.start();

      if (started) {
        logger.info('Webhook relay start initiated');
        return { success: true, message: 'Started successfully' };
      } else {
        return { success: false, message: 'Failed to start process' };
      }

    } catch (error) {
      logger.error(`Failed to start webhook relay: ${error.message}`);
      this.lastError = error.message;
      return { success: false, message: error.message };
    }
  }

  /**
   * Stop the webhook relay
   */
  async stop(force = false) {
    if (!this.processManager.isRunning) {
      logger.warn('Webhook relay is not running');
      return { success: false, message: 'Not running' };
    }

    try {
      logger.info('Stopping webhook relay');

      // Disable auto-restart to prevent immediate restart
      this.processManager.disableAutoRestart();

      const stopped = this.processManager.stop(force);

      if (stopped) {
        this.connectionUrl = null;
        this.startAttempts = 0; // Reset attempts on manual stop
        return { success: true, message: 'Stopped successfully' };
      } else {
        return { success: false, message: 'Failed to stop process' };
      }

    } catch (error) {
      logger.error(`Failed to stop webhook relay: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Restart the webhook relay
   */
  async restart() {
    logger.info('Restarting webhook relay');

    try {
      // Stop first if running
      if (this.processManager.isRunning) {
        await this.stop();

        // Wait a moment for clean shutdown
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Reset attempts and start
      this.startAttempts = 0;
      return await this.start();

    } catch (error) {
      logger.error(`Failed to restart webhook relay: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get relay status
   */
  getStatus() {
    const processStatus = this.processManager.getStatus();

    return {
      isRunning: processStatus.isRunning,
      pid: processStatus.pid,
      startTime: processStatus.startTime,
      uptime: processStatus.uptime,
      restartCount: processStatus.restartCount,
      connectionUrl: this.connectionUrl,
      relayName: this.relayName,
      destination: this.destination,
      lastError: this.lastError,
      startAttempts: this.startAttempts,
      maxStartAttempts: this.maxStartAttempts,
      autoRestart: this.autoRestart,
      config: {
        relayName: this.relayName,
        destination: this.destination,
        command: this.relayCommand
      }
    };
  }

  /**
   * Get recent logs
   */
  getLogs(lines = 50) {
    const output = this.processManager.getOutput(lines);
    const errors = this.processManager.getErrors(lines);

    return {
      stdout: output.split('\n').filter(line => line.trim()),
      stderr: errors.split('\n').filter(line => line.trim()),
      combined: (output + errors).split('\n').filter(line => line.trim())
    };
  }

  /**
   * Initialize the service
   */
  async initialize() {
    if (this.isInitialized) {
      return;
    }

    logger.info('Initializing Webhook Relay Service');

    // Check if relay command is available
    await this.checkRelayCommand();

    if (this.autoStart) {
      logger.info('Auto-start enabled, starting webhook relay');
      await this.start();
    }

    this.isInitialized = true;
    logger.info('Webhook Relay Service initialized');
  }

  /**
   * Check if relay command is available
   */
  async checkRelayCommand() {
    try {
      // Try to run relay version to check if it's available
      const versionCheck = new ProcessManager({
        processId: 'relay-version-check'
      });

      versionCheck.setCommand(this.relayCommand, ['version']);

      return new Promise((resolve) => {
        let hasOutput = false;

        versionCheck.on('stdout', (data) => {
          if (data.includes('version') || data.includes('relay')) {
            hasOutput = true;
          }
        });

        versionCheck.on('exit', () => {
          if (hasOutput) {
            logger.info('Webhook relay CLI is available');
          } else {
            logger.warn('Webhook relay CLI may not be properly installed');
          }
          resolve(hasOutput);
        });

        versionCheck.on('error', () => {
          logger.warn('Webhook relay CLI is not available or not in PATH');
          resolve(false);
        });

        versionCheck.start();
      });

    } catch (error) {
      logger.warn(`Failed to check relay command: ${error.message}`);
      return false;
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    if (this.processManager.isRunning) {
      throw new Error('Cannot update configuration while relay is running. Stop first.');
    }

    if (config.relayName) this.relayName = config.relayName;
    if (config.destination) this.destination = config.destination;
    if (config.relayCommand) this.relayCommand = config.relayCommand;
    if (config.autoStart !== undefined) this.autoStart = config.autoStart;
    if (config.autoRestart !== undefined) this.autoRestart = config.autoRestart;

    logger.info('Webhook relay configuration updated');
  }

  /**
   * Cleanup and dispose
   */
  dispose() {
    logger.info('Disposing Webhook Relay Service');

    if (this.processManager.isRunning) {
      this.processManager.stop(true);
    }

    this.processManager.dispose();
    this.removeAllListeners();
  }
}

export default WebhookRelayService;