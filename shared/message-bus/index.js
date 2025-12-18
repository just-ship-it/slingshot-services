import { createClient } from 'redis';
import { EventEmitter } from 'events';

class MessageBus extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      host: options.host || process.env.REDIS_HOST || 'localhost',
      port: options.port || process.env.REDIS_PORT || 6379,
      retryStrategy: (retries) => {
        if (retries > 10) {
          console.error('Redis connection failed after 10 retries');
          return null;
        }
        return Math.min(retries * 100, 3000);
      },
      ...options
    };

    this.publisher = null;
    this.subscriber = null;
    this.isConnected = false;
    this.isReconnecting = false;
    this.subscriptions = new Map();
    this.operationQueue = [];
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
  }

  async connect() {
    try {
      // Construct Redis URL with optional authentication
      const password = process.env.REDIS_PASSWORD;
      const database = process.env.REDIS_DB || 0;
      const redisUrl = password
        ? `redis://:${password}@${this.options.host}:${this.options.port}/${database}`
        : `redis://${this.options.host}:${this.options.port}/${database}`;

      // Create publisher client
      this.publisher = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: this.options.retryStrategy
        }
      });

      // Create subscriber client
      this.subscriber = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: this.options.retryStrategy
        }
      });

      // Set up error and connection event handlers
      this.setupConnectionHandlers(this.publisher, 'publisher');
      this.setupConnectionHandlers(this.subscriber, 'subscriber');

      // Connect both clients
      await this.publisher.connect();
      await this.subscriber.connect();

      this.isConnected = true;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      this.emit('connected');
      console.log('Message bus connected to Redis');

      // Process any queued operations
      await this.processQueuedOperations();

      return true;
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      this.isConnected = false;
      throw error;
    }
  }

  async publish(channel, message) {
    if (!this.isConnected) {
      if (this.isReconnecting) {
        // Queue the operation during reconnection
        return new Promise((resolve, reject) => {
          this.operationQueue.push({
            type: 'publish',
            args: [channel, message],
            resolve,
            reject,
            timestamp: Date.now()
          });
        });
      }
      throw new Error('Message bus not connected');
    }

    try {
      const payload = JSON.stringify({
        timestamp: new Date().toISOString(),
        channel,
        data: message
      });

      await this.publisher.publish(channel, payload);
      this.emit('message_published', { channel, message });

      return true;
    } catch (error) {
      console.error(`Failed to publish to ${channel}:`, error);
      throw error;
    }
  }

  async subscribe(channel, callback) {
    if (!this.isConnected) {
      if (this.isReconnecting) {
        // Queue the operation during reconnection
        return new Promise((resolve, reject) => {
          this.operationQueue.push({
            type: 'subscribe',
            args: [channel, callback],
            resolve,
            reject,
            timestamp: Date.now()
          });
        });
      }
      throw new Error('Message bus not connected');
    }

    try {
      // Store the subscription
      if (!this.subscriptions.has(channel)) {
        this.subscriptions.set(channel, new Set());
      }
      this.subscriptions.get(channel).add(callback);

      // Subscribe only once per channel
      if (this.subscriptions.get(channel).size === 1) {
        await this.subscriber.subscribe(channel, (message) => {
          try {
            const payload = JSON.parse(message);

            // Call all callbacks for this channel
            const callbacks = this.subscriptions.get(channel);
            if (callbacks) {
              callbacks.forEach(cb => {
                try {
                  cb(payload.data, payload);
                } catch (error) {
                  console.error(`Callback error for ${channel}:`, error);
                }
              });
            }

            this.emit('message_received', { channel, data: payload.data });
          } catch (error) {
            console.error(`Failed to process message from ${channel}:`, error);
          }
        });
      }

      console.log(`Subscribed to channel: ${channel}`);
      return true;
    } catch (error) {
      console.error(`Failed to subscribe to ${channel}:`, error);
      throw error;
    }
  }

  async unsubscribe(channel, callback) {
    if (!this.subscriptions.has(channel)) {
      return false;
    }

    const callbacks = this.subscriptions.get(channel);
    callbacks.delete(callback);

    // If no more callbacks, unsubscribe from Redis
    if (callbacks.size === 0) {
      await this.subscriber.unsubscribe(channel);
      this.subscriptions.delete(channel);
      console.log(`Unsubscribed from channel: ${channel}`);
    }

    return true;
  }

  async disconnect() {
    try {
      if (this.publisher) {
        await this.publisher.disconnect();
      }
      if (this.subscriber) {
        await this.subscriber.disconnect();
      }

      this.isConnected = false;
      this.subscriptions.clear();
      this.emit('disconnected');
      console.log('Message bus disconnected');

      return true;
    } catch (error) {
      console.error('Error disconnecting message bus:', error);
      throw error;
    }
  }

  // Convenience method for request-reply pattern
  async request(channel, message, timeout = 5000) {
    const correlationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const replyChannel = `${channel}.reply.${correlationId}`;

    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.unsubscribe(replyChannel, handler);
        reject(new Error(`Request timeout for ${channel}`));
      }, timeout);

      const handler = (reply) => {
        clearTimeout(timer);
        this.unsubscribe(replyChannel, handler);
        resolve(reply);
      };

      await this.subscribe(replyChannel, handler);
      await this.publish(channel, {
        ...message,
        correlationId,
        replyChannel
      });
    });
  }

  setupConnectionHandlers(client, clientType) {
    client.on('error', (err) => {
      console.error(`Redis ${clientType} Error:`, err);
      // Don't re-emit - this causes uncaught exceptions if no listener
      // this.emit('error', { type: clientType, error: err });
    });

    client.on('end', () => {
      console.warn(`Redis ${clientType} connection ended`);
      this.handleDisconnection();
    });

    client.on('close', () => {
      console.warn(`Redis ${clientType} connection closed`);
      this.handleDisconnection();
    });

    client.on('reconnecting', () => {
      console.log(`Redis ${clientType} reconnecting...`);
      this.isReconnecting = true;
    });

    client.on('connect', () => {
      console.log(`Redis ${clientType} connected`);
      if (this.publisher && this.subscriber &&
          this.publisher.isReady && this.subscriber.isReady) {
        this.isConnected = true;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
      }
    });
  }

  handleDisconnection() {
    if (this.isConnected) {
      this.isConnected = false;
      this.isReconnecting = true;
      console.log('Redis connection lost, attempting to reconnect...');
      this.emit('disconnected');

      // Start reconnection process
      this.attemptReconnection();
    }
  }

  async attemptReconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached, clearing operation queue');
      this.clearOperationQueue('Max reconnection attempts exceeded');
      this.isReconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);

    console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

    setTimeout(async () => {
      try {
        await this.connect();
        console.log('Reconnection successful');
      } catch (error) {
        console.error(`Reconnection attempt ${this.reconnectAttempts} failed:`, error);
        this.attemptReconnection();
      }
    }, delay);
  }

  async processQueuedOperations() {
    const queueCopy = [...this.operationQueue];
    this.operationQueue = [];

    console.log(`Processing ${queueCopy.length} queued operations`);

    for (const operation of queueCopy) {
      try {
        let result;
        if (operation.type === 'publish') {
          result = await this.publish(...operation.args);
        } else if (operation.type === 'subscribe') {
          result = await this.subscribe(...operation.args);
        }
        operation.resolve(result);
      } catch (error) {
        operation.reject(error);
      }
    }
  }

  clearOperationQueue(reason) {
    const queueCopy = [...this.operationQueue];
    this.operationQueue = [];

    queueCopy.forEach(operation => {
      operation.reject(new Error(`Operation failed: ${reason}`));
    });

    if (queueCopy.length > 0) {
      console.log(`Cleared ${queueCopy.length} queued operations due to: ${reason}`);
    }
  }

  // Clean up old queued operations (older than 10 seconds)
  cleanupStaleOperations() {
    const now = Date.now();
    const staleThreshold = 10000; // 10 seconds

    const staleBefore = this.operationQueue.length;
    this.operationQueue = this.operationQueue.filter(operation => {
      const isStale = (now - operation.timestamp) > staleThreshold;
      if (isStale) {
        operation.reject(new Error('Operation timeout during reconnection'));
      }
      return !isStale;
    });

    const staleAfter = this.operationQueue.length;
    if (staleBefore !== staleAfter) {
      console.log(`Cleaned up ${staleBefore - staleAfter} stale operations`);
    }
  }
}

// Export singleton instance
const messageBus = new MessageBus();

export default messageBus;
export { MessageBus };