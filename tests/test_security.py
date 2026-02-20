import pytest
from app.core.security import (
    hash_password,
    verify_password,
    hash_api_key,
    create_jwt_token,
    decode_jwt_token,
    encrypt_connection_string,
    decrypt_connection_string,
)


def test_password_hash_and_verify():
    hashed = hash_password("mysecret")
    assert hashed != "mysecret"
    assert verify_password("mysecret", hashed) is True
    assert verify_password("wrong", hashed) is False


def test_api_key_hash_is_deterministic():
    key = "proj_live_abc123xyz"
    h1 = hash_api_key(key)
    h2 = hash_api_key(key)
    assert h1 == h2
    assert len(h1) == 64  # SHA-256 hex


def test_jwt_create_and_decode():
    token = create_jwt_token(subject="admin:1")
    payload = decode_jwt_token(token)
    assert payload["sub"] == "admin:1"


def test_jwt_expired_raises():
    token = create_jwt_token(subject="admin:1", expire_minutes=-1)
    with pytest.raises(Exception):
        decode_jwt_token(token)


def test_fernet_encrypt_decrypt():
    original = "postgresql+asyncpg://user:pass@host:5432/db"
    encrypted = encrypt_connection_string(original)
    assert encrypted != original
    decrypted = decrypt_connection_string(encrypted)
    assert decrypted == original
