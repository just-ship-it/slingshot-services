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
    this.subscriptions = new Map();
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

      // Set up error handlers
      this.publisher.on('error', (err) => {
        console.error('Redis Publisher Error:', err);
        this.emit('error', { type: 'publisher', error: err });
      });

      this.subscriber.on('error', (err) => {
        console.error('Redis Subscriber Error:', err);
        this.emit('error', { type: 'subscriber', error: err });
      });

      // Connect both clients
      await this.publisher.connect();
      await this.subscriber.connect();

      this.isConnected = true;
      this.emit('connected');
      console.log('Message bus connected to Redis');

      return true;
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      this.isConnected = false;
      throw error;
    }
  }

  async publish(channel, message) {
    if (!this.isConnected) {
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
}

// Export singleton instance
const messageBus = new MessageBus();

export default messageBus;
export { MessageBus };