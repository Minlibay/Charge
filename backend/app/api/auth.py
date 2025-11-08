"""Authentication API endpoints."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.security import (
    RefreshTokenError,
    clear_refresh_cookie,
    create_access_token,
    create_refresh_token,
    get_password_hash,
    set_refresh_cookie,
    validate_refresh_token,
    verify_password,
)
from app.database import get_db
from app.models import User
from app.schemas import LoginRequest, RefreshRequest, Token, UserCreate, UserRead

router = APIRouter()
settings = get_settings()


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def register_user(user_in: UserCreate, db: Session = Depends(get_db)) -> User:
    """Register a new user in the system."""

    existing_user = db.execute(select(User).where(User.login == user_in.login)).scalar_one_or_none()
    if existing_user is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Login is already taken",
        )

    user = User(
        login=user_in.login,
        display_name=user_in.display_name,
        presence_status=user_in.status,
        hashed_password=get_password_hash(user_in.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=Token)
def login_user(credentials: LoginRequest, response: Response, db: Session = Depends(get_db)) -> Token:
    """Authenticate a user and return a JWT access token."""

    actual_response = response
    actual_db = db
    if isinstance(response, Session):  # allow unit tests to pass the DB session positionally
        actual_db = response
        actual_response = Response()

    db_user = actual_db.execute(select(User).where(User.login == credentials.login)).scalar_one_or_none()
    if db_user is None or not verify_password(credentials.password, db_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect login or password",
        )

    remember_me = bool(credentials.remember_me and settings.remember_me_enabled)
    access_token_expires = timedelta(minutes=settings.access_token_expire_minutes)
    access_token = create_access_token({"sub": str(db_user.id)}, expires_delta=access_token_expires)
    refresh_token, refresh_ttl = create_refresh_token(str(db_user.id), remember_me=remember_me)
    set_refresh_cookie(actual_response, refresh_token, refresh_ttl)

    return Token(
        access_token=access_token,
        refresh_token=refresh_token,
        token_type="bearer",
        expires_in=int(access_token_expires.total_seconds()),
    )


@router.post("/refresh", response_model=Token)
def refresh_access_token(
    payload: RefreshRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> Token:
    """Issue a new access token when a refresh token is still valid."""

    refresh_token = payload.refresh_token or request.cookies.get(settings.refresh_token_cookie_name)
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token is required")

    try:
        refresh_data = validate_refresh_token(refresh_token, revoke=True)
    except RefreshTokenError as exc:
        clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate refresh token",
        ) from exc

    try:
        user_id = int(refresh_data.subject)
    except (TypeError, ValueError) as exc:
        clear_refresh_cookie(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token subject") from exc

    user = db.get(User, user_id)
    if user is None:
        clear_refresh_cookie(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    remember_me = refresh_data.remember_me and settings.remember_me_enabled
    access_token_expires = timedelta(minutes=settings.access_token_expire_minutes)
    access_token = create_access_token({"sub": str(user.id)}, expires_delta=access_token_expires)
    new_refresh_token, refresh_ttl = create_refresh_token(str(user.id), remember_me=remember_me)
    set_refresh_cookie(response, new_refresh_token, refresh_ttl)

    return Token(
        access_token=access_token,
        refresh_token=new_refresh_token,
        token_type="bearer",
        expires_in=int(access_token_expires.total_seconds()),
    )
