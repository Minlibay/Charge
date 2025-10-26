"""Unit tests for authentication helpers and endpoints."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api.auth import login_user
from app.api.deps import get_user_from_token
from app.core.security import create_access_token, get_password_hash
from app.models import User
from app.schemas import LoginRequest


@pytest.fixture()
def user(db_session):
    db_user = User(
        login="tester",
        hashed_password=get_password_hash("supersecret"),
        display_name="Tester",
    )
    db_session.add(db_user)
    db_session.commit()
    return db_user


def test_login_user_returns_token(db_session, user):
    """Successful login should return a bearer token."""

    credentials = LoginRequest(login="tester", password="supersecret")
    token = login_user(credentials, db_session)

    assert token.token_type == "bearer"
    assert isinstance(token.access_token, str) and token.access_token


def test_login_user_rejects_invalid_credentials(db_session):
    """Invalid credentials must raise an HTTP 401 error."""

    credentials = LoginRequest(login="ghost", password="doesnotmatter")
    with pytest.raises(HTTPException) as exc:
        login_user(credentials, db_session)

    assert exc.value.status_code == 401
    assert "Incorrect login" in exc.value.detail


def test_get_user_from_token(db_session, user):
    """Tokens should resolve to existing users."""

    token = create_access_token({"sub": str(user.id)})
    resolved = get_user_from_token(token, db_session)

    assert resolved.id == user.id
    assert resolved.login == user.login


def test_get_user_from_token_invalid_payload(db_session):
    """Invalid tokens must result in a 401 error."""

    with pytest.raises(HTTPException) as exc:
        get_user_from_token("invalid-token", db_session)

    assert exc.value.status_code == 401
    assert "Could not validate credentials" in exc.value.detail
