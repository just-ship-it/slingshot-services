// Candle data model for OHLCV data
export class Candle {
  constructor(data) {
    this.symbol = data.symbol;
    this.timestamp = data.timestamp;
    this.open = data.open;
    this.high = data.high;
    this.low = data.low;
    this.close = data.close;
    this.volume = data.volume || 0;
    this.timeframe = data.timeframe || '15';
  }

  toDict() {
    return {
      symbol: this.symbol,
      timestamp: this.timestamp,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.close,
      volume: this.volume,
      timeframe: this.timeframe
    };
  }

  static fromDict(data) {
    return new Candle(data);
  }

  get range() {
    return this.high - this.low;
  }

  get body() {
    return Math.abs(this.close - this.open);
  }

  get isBullish() {
    return this.close > this.open;
  }

  get isBearish() {
    return this.close < this.open;
  }
}

export default Candle;