"""Authentication API endpoints."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.security import create_access_token, get_password_hash, verify_password
from app.database import get_db
from app.models import User
from app.schemas import LoginRequest, Token, UserCreate, UserRead

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
def login_user(credentials: LoginRequest, db: Session = Depends(get_db)) -> Token:
    """Authenticate a user and return a JWT access token."""

    db_user = db.execute(select(User).where(User.login == credentials.login)).scalar_one_or_none()
    if db_user is None or not verify_password(credentials.password, db_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect login or password",
        )

    access_token_expires = timedelta(minutes=settings.access_token_expire_minutes)
    access_token = create_access_token({"sub": str(db_user.id)}, expires_delta=access_token_expires)
    return Token(access_token=access_token, token_type="bearer")
