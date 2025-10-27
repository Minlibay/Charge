"""Direct messaging and friends management endpoints."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user
from app.database import get_db
from app.models import (
    DirectConversation,
    DirectMessage,
    FriendLink,
    FriendRequestStatus,
    User,
)
from app.schemas import (
    DirectConversationRead,
    DirectMessageCreate,
    DirectMessageRead,
    FriendRequestCreate,
    FriendRequestList,
    FriendRequestRead,
    PublicUser,
)

router = APIRouter(prefix="/dm", tags=["direct-messages"])


def _serialize_public_user(user: User) -> PublicUser:
    return PublicUser(
        id=user.id,
        login=user.login,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        status=user.presence_status,
    )


def _normalize_pair(user_id: int, other_id: int) -> tuple[int, int]:
    return (user_id, other_id) if user_id < other_id else (other_id, user_id)


def _get_friend_link(user_id: int, other_id: int, db: Session) -> FriendLink | None:
    stmt = select(FriendLink).where(
        or_(
            (FriendLink.requester_id == user_id) & (FriendLink.addressee_id == other_id),
            (FriendLink.requester_id == other_id) & (FriendLink.addressee_id == user_id),
        )
    )
    return db.execute(stmt).scalar_one_or_none()


def _ensure_conversation(user_id: int, other_id: int, db: Session) -> DirectConversation:
    user_a_id, user_b_id = _normalize_pair(user_id, other_id)
    stmt = select(DirectConversation).where(
        DirectConversation.user_a_id == user_a_id,
        DirectConversation.user_b_id == user_b_id,
    )
    conversation = db.execute(stmt).scalar_one_or_none()
    if conversation is None:
        conversation = DirectConversation(user_a_id=user_a_id, user_b_id=user_b_id)
        db.add(conversation)
        db.flush()
    return conversation


@router.get("/friends", response_model=list[PublicUser])
async def list_friends(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PublicUser]:
    """Return accepted friends for the current user."""

    stmt = (
        select(FriendLink)
        .where(
            FriendLink.status == FriendRequestStatus.ACCEPTED,
            or_(
                FriendLink.requester_id == current_user.id,
                FriendLink.addressee_id == current_user.id,
            ),
        )
        .options(selectinload(FriendLink.requester), selectinload(FriendLink.addressee))
    )
    links = db.execute(stmt).scalars().all()
    friends: list[PublicUser] = []
    for link in links:
        other = link.addressee if link.requester_id == current_user.id else link.requester
        if other is None:
            continue
        friends.append(_serialize_public_user(other))
    friends.sort(key=lambda friend: (friend.display_name or friend.login).lower())
    return friends


@router.get("/requests", response_model=FriendRequestList)
async def list_friend_requests(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FriendRequestList:
    """Return incoming and outgoing friend requests."""

    stmt = (
        select(FriendLink)
        .where(
            FriendLink.status == FriendRequestStatus.PENDING,
            or_(
                FriendLink.requester_id == current_user.id,
                FriendLink.addressee_id == current_user.id,
            ),
        )
        .options(selectinload(FriendLink.requester), selectinload(FriendLink.addressee))
        .order_by(FriendLink.created_at.asc())
    )
    entries = db.execute(stmt).scalars().all()
    incoming: list[FriendRequestRead] = []
    outgoing: list[FriendRequestRead] = []
    for entry in entries:
        payload = FriendRequestRead(
            id=entry.id,
            requester=_serialize_public_user(entry.requester),
            addressee=_serialize_public_user(entry.addressee),
            status=entry.status,
            created_at=entry.created_at,
            responded_at=entry.responded_at,
        )
        if entry.addressee_id == current_user.id:
            incoming.append(payload)
        else:
            outgoing.append(payload)
    return FriendRequestList(incoming=incoming, outgoing=outgoing)


@router.post("/requests", response_model=FriendRequestRead, status_code=status.HTTP_201_CREATED)
async def create_friend_request(
    payload: FriendRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FriendRequestRead:
    """Send a new friend request."""

    stmt = select(User).where(User.login == payload.login)
    target = db.execute(stmt).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if target.id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Нельзя добавить себя")

    existing = _get_friend_link(current_user.id, target.id, db)
    if existing is not None:
        if existing.status == FriendRequestStatus.ACCEPTED:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Уже в друзьях")
        if existing.requester_id == current_user.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Запрос уже отправлен")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Есть входящий запрос")

    link = FriendLink(
        requester_id=current_user.id,
        addressee_id=target.id,
        status=FriendRequestStatus.PENDING,
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return FriendRequestRead(
        id=link.id,
        requester=_serialize_public_user(link.requester),
        addressee=_serialize_public_user(link.addressee),
        status=link.status,
        created_at=link.created_at,
        responded_at=link.responded_at,
    )


def _require_request(request_id: int, db: Session) -> FriendLink:
    stmt = (
        select(FriendLink)
        .where(FriendLink.id == request_id)
        .options(selectinload(FriendLink.requester), selectinload(FriendLink.addressee))
    )
    request = db.execute(stmt).scalar_one_or_none()
    if request is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Запрос не найден")
    return request


@router.post("/requests/{request_id}/accept", response_model=FriendRequestRead)
async def accept_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FriendRequestRead:
    request = _require_request(request_id, db)
    if request.addressee_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Недостаточно прав")
    if request.status == FriendRequestStatus.ACCEPTED:
        return FriendRequestRead(
            id=request.id,
            requester=_serialize_public_user(request.requester),
            addressee=_serialize_public_user(request.addressee),
            status=request.status,
            created_at=request.created_at,
            responded_at=request.responded_at,
        )

    request.status = FriendRequestStatus.ACCEPTED
    request.responded_at = datetime.now(timezone.utc)
    db.add(request)
    _ensure_conversation(request.requester_id, request.addressee_id, db)
    db.commit()
    db.refresh(request)
    return FriendRequestRead(
        id=request.id,
        requester=_serialize_public_user(request.requester),
        addressee=_serialize_public_user(request.addressee),
        status=request.status,
        created_at=request.created_at,
        responded_at=request.responded_at,
    )


@router.post("/requests/{request_id}/reject", response_model=FriendRequestRead)
async def reject_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FriendRequestRead:
    request = _require_request(request_id, db)
    if request.addressee_id != current_user.id and request.requester_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Недостаточно прав")

    request.status = FriendRequestStatus.DECLINED
    request.responded_at = datetime.now(timezone.utc)
    db.add(request)
    db.commit()
    db.refresh(request)
    return FriendRequestRead(
        id=request.id,
        requester=_serialize_public_user(request.requester),
        addressee=_serialize_public_user(request.addressee),
        status=request.status,
        created_at=request.created_at,
        responded_at=request.responded_at,
    )


def _serialize_message(message: DirectMessage) -> DirectMessageRead:
    return DirectMessageRead(
        id=message.id,
        conversation_id=message.conversation_id,
        sender_id=message.sender_id,
        recipient_id=message.recipient_id,
        content=message.content,
        created_at=message.created_at,
        read_at=message.read_at,
        sender=_serialize_public_user(message.sender),
    )


def _serialize_conversation(
    conversation: DirectConversation,
    current_user_id: int,
    db: Session,
) -> DirectConversationRead:
    other = conversation.user_a if conversation.user_a_id != current_user_id else conversation.user_b
    if other is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Некорректный диалог")

    last_message_stmt = (
        select(DirectMessage)
        .where(DirectMessage.conversation_id == conversation.id)
        .order_by(DirectMessage.created_at.desc())
        .limit(1)
        .options(selectinload(DirectMessage.sender))
    )
    last_message = db.execute(last_message_stmt).scalar_one_or_none()
    unread_count = db.execute(
        select(func.count(DirectMessage.id)).where(
            DirectMessage.conversation_id == conversation.id,
            DirectMessage.recipient_id == current_user_id,
            DirectMessage.read_at.is_(None),
        )
    ).scalar_one()

    return DirectConversationRead(
        id=conversation.id,
        participant=_serialize_public_user(other),
        last_message=_serialize_message(last_message) if last_message else None,
        unread_count=unread_count,
    )


@router.get("/conversations", response_model=list[DirectConversationRead])
async def list_conversations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[DirectConversationRead]:
    stmt = (
        select(DirectConversation)
        .where(
            or_(
                DirectConversation.user_a_id == current_user.id,
                DirectConversation.user_b_id == current_user.id,
            )
        )
        .order_by(DirectConversation.updated_at.desc())
        .options(selectinload(DirectConversation.user_a), selectinload(DirectConversation.user_b))
    )
    conversations = db.execute(stmt).scalars().all()
    return [
        _serialize_conversation(conversation, current_user.id, db) for conversation in conversations
    ]


@router.get("/conversations/{user_id}/messages", response_model=list[DirectMessageRead])
async def list_messages(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[DirectMessageRead]:
    """Return messages exchanged with a specific user."""

    friendship = _get_friend_link(current_user.id, user_id, db)
    if friendship is None or friendship.status != FriendRequestStatus.ACCEPTED:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Пользователь не в друзьях")

    conversation = _ensure_conversation(current_user.id, user_id, db)

    stmt = (
        select(DirectMessage)
        .where(DirectMessage.conversation_id == conversation.id)
        .order_by(DirectMessage.created_at.asc())
        .options(selectinload(DirectMessage.sender))
    )
    messages = db.execute(stmt).scalars().all()

    now = datetime.now(timezone.utc)
    for message in messages:
        if message.recipient_id == current_user.id and message.read_at is None:
            message.read_at = now
            db.add(message)
    db.commit()

    return [_serialize_message(message) for message in messages]


@router.post("/conversations/{user_id}/messages", response_model=DirectMessageRead, status_code=status.HTTP_201_CREATED)
async def create_message(
    user_id: int,
    payload: DirectMessageCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DirectMessageRead:
    """Send a direct message to a friend."""

    friendship = _get_friend_link(current_user.id, user_id, db)
    if friendship is None or friendship.status != FriendRequestStatus.ACCEPTED:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Пользователь не в друзьях")

    conversation = _ensure_conversation(current_user.id, user_id, db)
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Сообщение не может быть пустым")

    message = DirectMessage(
        conversation_id=conversation.id,
        sender_id=current_user.id,
        recipient_id=user_id,
        content=content,
    )
    message.sender = current_user
    conversation.last_message_at = datetime.now(timezone.utc)
    db.add(message)
    db.add(conversation)
    db.commit()
    db.refresh(message)
    db.refresh(conversation)
    return _serialize_message(message)
