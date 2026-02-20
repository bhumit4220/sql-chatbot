import hashlib
from datetime import datetime, timedelta, timezone

import bcrypt
from cryptography.fernet import Fernet
from jose import JWTError, jwt

from app.config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def create_jwt_token(subject: str, expire_minutes: int | None = None) -> str:
    if expire_minutes is None:
        expire_minutes = settings.jwt_expire_minutes
    expire = datetime.now(timezone.utc) + timedelta(minutes=expire_minutes)
    return jwt.encode(
        {"sub": subject, "exp": expire},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )


def decode_jwt_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError as e:
        raise ValueError(f"Invalid token: {e}") from e


def _get_fernet() -> Fernet:
    return Fernet(settings.encryption_key.encode() if isinstance(settings.encryption_key, str) else settings.encryption_key)


def encrypt_connection_string(plain: str) -> str:
    return _get_fernet().encrypt(plain.encode()).decode()


def decrypt_connection_string(encrypted: str) -> str:
    return _get_fernet().decrypt(encrypted.encode()).decode()
