"""Historical data archiver for storing OHLCV candles to CSV files."""

import csv
import logging
import os
from datetime import datetime, timezone, time, timedelta
from pathlib import Path
from typing import Dict, Optional, Set
import pytz

from ..models.candle import Candle

logger = logging.getLogger(__name__)


class HistoricalArchiver:
    """Archives OHLCV candle data to CSV files for backtesting."""

    def __init__(self, data_directory: str = "./data/ohlcv"):
        """Initialize historical archiver.

        Args:
            data_directory: Directory to store CSV files
        """
        self.data_directory = Path(data_directory)
        self.data_directory.mkdir(parents=True, exist_ok=True)

        # Track open file handles and writers
        self.file_handles: Dict[str, object] = {}
        self.csv_writers: Dict[str, csv.writer] = {}
        self.current_session_date: Optional[str] = None

        # EST timezone for session management
        self.est_tz = pytz.timezone('US/Eastern')

        # Symbols we want to archive
        self.target_symbols = {'NQ', 'MNQ', 'ES', 'MES'}

        # Contract month mapping (will need to be updated quarterly)
        self.contract_mapping = {
            'NQ': self._get_current_contract('NQ'),
            'MNQ': self._get_current_contract('MNQ'),
            'ES': self._get_current_contract('ES'),
            'MES': self._get_current_contract('MES')
        }

        logger.info(f"HistoricalArchiver initialized with data directory: {self.data_directory}")
        logger.info(f"Contract mappings: {self.contract_mapping}")

    def _round_to_tick(self, price: float) -> float:
        """Round price to nearest 0.25 tick increment.

        Args:
            price: Raw price value

        Returns:
            Price rounded to nearest 0.25 (0.00, 0.25, 0.50, 0.75)
        """
        # Round to nearest 0.25
        return round(price * 4) / 4

    def _get_current_contract(self, base_symbol: str) -> str:
        """Get current contract symbol based on date.

        Args:
            base_symbol: Base symbol like 'NQ'

        Returns:
            Contract symbol like 'NQH6'
        """
        now = datetime.now()

        # Contract months: H=Mar, M=Jun, U=Sep, Z=Dec
        # Approximate contract rollover dates
        if now.month <= 3:
            month_code = 'H'  # March
        elif now.month <= 6:
            month_code = 'M'  # June
        elif now.month <= 9:
            month_code = 'U'  # September
        else:
            month_code = 'Z'  # December

        # Use last digit of year
        year_code = str(now.year)[-1]

        return f"{base_symbol}{month_code}{year_code}"

    def _get_session_date(self, timestamp: float) -> str:
        """Get trading session date for a timestamp.

        Trading session runs from 6PM EST to 4PM EST next day.

        Args:
            timestamp: Unix timestamp

        Returns:
            Session date in YYYY-MM-DD format
        """
        dt = datetime.fromtimestamp(timestamp, self.est_tz)

        # If before 4PM EST, use current date
        # If after 6PM EST, use current date
        # If between 4PM-6PM EST, use previous date (gap between sessions)
        if dt.hour >= 18 or dt.hour < 16:
            if dt.hour >= 18:
                # After 6PM, this is the start of tomorrow's session
                return dt.strftime('%Y-%m-%d')
            else:
                # Before 4PM, this is today's session
                return dt.strftime('%Y-%m-%d')
        else:
            # Between 4PM-6PM EST, no active session
            # Use previous day
            prev_day = dt.replace(hour=0, minute=0, second=0, microsecond=0)
            prev_day = prev_day - timedelta(days=1)
            return prev_day.strftime('%Y-%m-%d')

    def _get_csv_filename(self, symbol: str, session_date: str) -> str:
        """Get CSV filename for symbol and session.

        Args:
            symbol: Base symbol like 'NQ'
            session_date: Session date in YYYY-MM-DD format

        Returns:
            Filename like 'NQ_1m_2026-01-01.csv'
        """
        return f"{symbol}_1m_{session_date}.csv"

    def _get_file_path(self, symbol: str, session_date: str) -> Path:
        """Get full file path for CSV file.

        Args:
            symbol: Base symbol
            session_date: Session date

        Returns:
            Full path to CSV file
        """
        filename = self._get_csv_filename(symbol, session_date)
        return self.data_directory / filename

    def _ensure_csv_file(self, symbol: str, session_date: str) -> str:
        """Ensure CSV file exists and return file key.

        Args:
            symbol: Base symbol
            session_date: Session date

        Returns:
            File key for tracking open handles
        """
        file_key = f"{symbol}_{session_date}"

        if file_key not in self.file_handles:
            file_path = self._get_file_path(symbol, session_date)

            # Check if file exists to determine if we need headers
            file_exists = file_path.exists()

            # Open file in append mode
            file_handle = open(file_path, 'a', newline='', encoding='utf-8')
            writer = csv.writer(file_handle)

            # Write headers if file is new
            if not file_exists:
                headers = ['ts_event', 'rtype', 'publisher_id', 'instrument_id', 'open', 'high', 'low', 'close', 'volume', 'symbol']
                writer.writerow(headers)
                logger.info(f"Created new CSV file: {file_path}")

            self.file_handles[file_key] = file_handle
            self.csv_writers[file_key] = writer

        return file_key

    def _close_old_files(self, current_session_date: str):
        """Close file handles for old sessions.

        Args:
            current_session_date: Current session date
        """
        keys_to_remove = []

        for file_key, handle in self.file_handles.items():
            if current_session_date not in file_key:
                try:
                    handle.close()
                    keys_to_remove.append(file_key)
                    logger.info(f"Closed old session file: {file_key}")
                except Exception as e:
                    logger.error(f"Error closing file {file_key}: {e}")

        for key in keys_to_remove:
            del self.file_handles[key]
            if key in self.csv_writers:
                del self.csv_writers[key]

    def archive_candle(self, candle: Candle):
        """Archive a completed candle to CSV.

        Args:
            candle: Completed OHLCV candle
        """
        # Only archive symbols we're interested in
        if candle.symbol not in self.target_symbols:
            logger.debug(f"Skipping archive for symbol {candle.symbol} (not in target list)")
            return

        session_date = self._get_session_date(candle.timestamp)

        # Close old files if we've moved to a new session
        if self.current_session_date != session_date:
            if self.current_session_date:
                self._close_old_files(session_date)
            self.current_session_date = session_date

        try:
            file_key = self._ensure_csv_file(candle.symbol, session_date)
            writer = self.csv_writers[file_key]

            # Convert timestamp to ISO format with nanosecond precision
            dt = datetime.fromtimestamp(candle.timestamp, timezone.utc)
            ts_event = dt.strftime('%Y-%m-%dT%H:%M:%S.%f000Z')

            # Get contract symbol for this base symbol
            contract_symbol = self.contract_mapping.get(candle.symbol, candle.symbol)

            # Write row in expected format
            # ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
            row = [
                ts_event,           # ts_event: ISO timestamp with nanoseconds
                33,                 # rtype: 33 for bar data (consistent with your format)
                1,                  # publisher_id: 1 (consistent with your format)
                self._get_instrument_id(candle.symbol),  # instrument_id: numeric ID
                f"{self._round_to_tick(candle.open):.2f}",      # open: rounded to nearest tick
                f"{self._round_to_tick(candle.high):.2f}",      # high: rounded to nearest tick
                f"{self._round_to_tick(candle.low):.2f}",       # low: rounded to nearest tick
                f"{self._round_to_tick(candle.close):.2f}",     # close: rounded to nearest tick
                int(candle.volume),        # volume: integer
                contract_symbol            # symbol: contract symbol like NQH6
            ]

            writer.writerow(row)

            # Flush to disk periodically
            if hasattr(self.file_handles[file_key], 'flush'):
                self.file_handles[file_key].flush()

            logger.debug(f"Archived {candle.symbol} 1m candle: {candle.close} @ {session_date}")

        except Exception as e:
            logger.error(f"Error archiving candle for {candle.symbol}: {e}")

    def _get_instrument_id(self, symbol: str) -> int:
        """Get numeric instrument ID for symbol.

        Args:
            symbol: Base symbol like 'NQ'

        Returns:
            Numeric instrument ID
        """
        # These should match your historical data's instrument_id values
        mapping = {
            'NQ': 4378,
            'MNQ': 2786,
            'ES': 4379,   # Estimated, adjust based on your data
            'MES': 2787   # Estimated, adjust based on your data
        }

        return mapping.get(symbol, 9999)  # Default fallback

    def close_all_files(self):
        """Close all open file handles."""
        for file_key, handle in self.file_handles.items():
            try:
                handle.close()
                logger.info(f"Closed file: {file_key}")
            except Exception as e:
                logger.error(f"Error closing file {file_key}: {e}")

        self.file_handles.clear()
        self.csv_writers.clear()

    def get_stats(self) -> Dict:
        """Get archiver statistics.

        Returns:
            Statistics about files and archived data
        """
        return {
            'data_directory': str(self.data_directory),
            'current_session_date': self.current_session_date,
            'open_files': len(self.file_handles),
            'target_symbols': list(self.target_symbols),
            'contract_mappings': self.contract_mapping,
            'active_files': list(self.file_handles.keys())
        }

    def update_contract_mappings(self, mappings: Dict[str, str]):
        """Update contract symbol mappings.

        Args:
            mappings: Dict of {base_symbol: contract_symbol}
        """
        self.contract_mapping.update(mappings)
        logger.info(f"Updated contract mappings: {mappings}")

    def __del__(self):
        """Cleanup: close all files when archiver is destroyed."""
        try:
            self.close_all_files()
        except:
            pass