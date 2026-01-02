"""
TradingView Authentication Manager - Direct API Version
Handles automatic JWT token extraction using direct HTTP requests (no browser needed)
"""
import json
import base64
import os
import re
from datetime import datetime
from pathlib import Path
import requests
from websocket import create_connection
import time
import logging

logger = logging.getLogger(__name__)


class TradingViewAuth:
    """Manages TradingView authentication and JWT token refresh via direct API calls."""

    def __init__(self, credentials_string=None, token_cache_file=".tv_token_cache.json"):
        self.credentials_string = credentials_string
        self.token_cache_file = Path(token_cache_file)
        self.jwt_token = None
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin': 'https://www.tradingview.com',
            'Referer': 'https://www.tradingview.com/',
        })

    def encode_credentials(self, username, password):
        """Encode credentials to base64 string."""
        credentials = {"username": username, "password": password}
        return base64.b64encode(json.dumps(credentials).encode()).decode()

    def load_credentials(self):
        """Load credentials from environment string."""
        if not self.credentials_string:
            raise ValueError("No TradingView credentials provided in environment")

        try:
            return json.loads(base64.b64decode(self.credentials_string).decode())
        except Exception as e:
            logger.error(f"Failed to decode credentials: {e}")
            raise ValueError("Invalid TRADINGVIEW_CREDENTIALS format. Expected base64 encoded JSON with username and password")

    def _parse_jwt_payload(self, token):
        """Parse JWT token and extract payload."""
        try:
            parts = token.split('.')
            payload = parts[1]
            padding = len(payload) % 4
            if padding:
                payload += '=' * (4 - padding)
            return json.loads(base64.urlsafe_b64decode(payload))
        except Exception as e:
            logger.error(f"Failed to parse JWT token: {e}")
            return None

    def _is_token_valid(self, token, buffer_minutes=5):
        """Check if token is valid and not expiring soon."""
        if not token:
            return False
        payload = self._parse_jwt_payload(token)
        if not payload or 'exp' not in payload:
            return False
        time_remaining = payload['exp'] - datetime.now().timestamp()
        return time_remaining > (buffer_minutes * 60)

    def load_cached_token(self):
        """Load token from cache if valid."""
        if not self.token_cache_file.exists():
            return None
        try:
            with open(self.token_cache_file, 'r') as f:
                data = json.load(f)
                token = data.get('jwt_token')
                if self._is_token_valid(token):
                    logger.info("Loaded valid token from cache")
                    return token
                else:
                    logger.info("Cached token is expired or expiring soon")
                    return None
        except Exception as e:
            logger.error(f"Failed to load cached token: {e}")
            return None

    def save_token_to_cache(self, token):
        """Save token to cache file."""
        payload = self._parse_jwt_payload(token)
        if payload:
            data = {
                'jwt_token': token,
                'expires_at': datetime.fromtimestamp(payload.get('exp')).isoformat(),
                'cached_at': datetime.now().isoformat()
            }
            with open(self.token_cache_file, 'w') as f:
                json.dump(data, f, indent=2)
            os.chmod(self.token_cache_file, 0o600)
            logger.info(f"Token cached until {data['expires_at']}")

    def login_and_get_token(self):
        """Login to TradingView and extract JWT token via websocket."""
        credentials = self.load_credentials()
        logger.info(f"Logging in as {credentials['username']}")

        # Step 1: Sign in via API
        response = self.session.get('https://www.tradingview.com/')
        signin_data = {
            'username': credentials['username'],
            'password': credentials['password'],
            'remember': 'on'
        }
        response = self.session.post('https://www.tradingview.com/accounts/signin/', data=signin_data)

        if response.status_code != 200:
            raise Exception(f"Login failed with status {response.status_code}")

        response_json = response.json()
        if response_json.get('error'):
            raise Exception(f"Login failed: {response_json.get('error')}")

        logger.info("Login successful, extracting JWT token...")

        # Step 2: Connect to websocket to capture JWT token
        cookies_str = "; ".join([f"{c.name}={c.value}" for c in self.session.cookies])
        ws_headers = {
            "User-Agent": self.session.headers['User-Agent'],
            "Origin": "https://www.tradingview.com",
            "Cookie": cookies_str
        }

        ws = create_connection("wss://data.tradingview.com/socket.io/websocket",
                               header=ws_headers, timeout=10)

        def send_ws_message(func, params):
            message = json.dumps({"m": func, "p": params})
            ws.send(f"~m~{len(message)}~m~{message}")

        send_ws_message("set_auth_token", ["unauthorized_user_token"])
        send_ws_message("chart_create_session", ["test_session", ""])

        jwt_token = None
        for _ in range(20):
            try:
                result = ws.recv()
                if 'set_auth_token' in result:
                    match = re.search(r'"set_auth_token","p":\["([^"]+)"\]', result)
                    if match:
                        token = match.group(1)
                        if token != "unauthorized_user_token" and token.startswith('eyJ'):
                            jwt_token = token
                            logger.info("JWT token extracted successfully")
                            break
                time.sleep(0.1)
            except Exception:
                break

        ws.close()

        if not jwt_token:
            raise Exception("Failed to capture JWT token")
        return jwt_token

    def get_valid_token(self, force_refresh=False, hardcoded_token=None):
        """Get a valid JWT token, preferring environment token.

        Args:
            force_refresh: Force refresh even if cached token exists (ignored when hardcoded_token provided)
            hardcoded_token: Use provided token instead of extracting via websocket
        """
        # Always use hardcoded token if provided (skip websocket extraction entirely)
        if hardcoded_token:
            if self._is_token_valid(hardcoded_token):
                logger.info("Using provided JWT token from environment")
                self.jwt_token = hardcoded_token
                return hardcoded_token
            else:
                logger.warning("Provided JWT token is invalid or expired, but using anyway")
                logger.warning("Please update TRADINGVIEW_JWT_TOKEN in environment")
                self.jwt_token = hardcoded_token
                return hardcoded_token

        # Fallback to cached token
        if not force_refresh:
            cached = self.load_cached_token()
            if cached:
                logger.info("Using cached JWT token")
                self.jwt_token = cached
                return cached

        # Only attempt websocket extraction if no hardcoded token provided
        logger.warning("No environment JWT token provided, attempting websocket extraction...")
        try:
            token = self.login_and_get_token()
            if token:
                self.save_token_to_cache(token)
                self.jwt_token = token
                return token
        except Exception as e:
            logger.error(f"Failed to extract JWT token via websocket: {e}")

        raise Exception("Failed to obtain JWT token - please set TRADINGVIEW_JWT_TOKEN in environment")

    def get_token_info(self, token=None):
        """Get information about a token."""
        token = token or self.jwt_token
        if not token:
            return None
        payload = self._parse_jwt_payload(token)
        if not payload:
            return None
        return {
            'user_id': payload.get('user_id'),
            'plan': payload.get('plan'),
            'expires_at': datetime.fromtimestamp(payload.get('exp')).isoformat(),
            'time_remaining_minutes': int((payload.get('exp') - datetime.now().timestamp()) / 60),
            'is_valid': self._is_token_valid(token)
        }