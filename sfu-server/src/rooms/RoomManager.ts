import { Room } from './Room.js';

export class RoomManager {
  private rooms: Map<string, Room> = new Map();

  async createRoom(roomId: string): Promise<Room> {
    if (this.rooms.has(roomId)) {
      throw new Error(`Room ${roomId} already exists`);
    }

    const room = new Room(roomId);
    await room.initialize();
    this.rooms.set(roomId, room);

    console.log(`[RoomManager] Room ${roomId} created. Total rooms: ${this.rooms.size}`);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  async getOrCreateRoom(roomId: string): Promise<Room> {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = await this.createRoom(roomId);
    }
    return room;
  }

  async deleteRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room) {
      await room.close();
      this.rooms.delete(roomId);
      console.log(`[RoomManager] Room ${roomId} deleted. Total rooms: ${this.rooms.size}`);
    }
  }

  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  getRoomStats(): Array<{ id: string; peersCount: number; peerIds: string[] }> {
    return Array.from(this.rooms.values()).map(room => room.getStats());
  }

  getTotalRooms(): number {
    return this.rooms.size;
  }
}

export const roomManager = new RoomManager();

