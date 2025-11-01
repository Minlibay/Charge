import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useWorkspaceStore } from '../workspaceStore';
import type { ChannelType } from '../../types';

function createChannel(id: number, name: string, type: ChannelType, letter: string) {
  const timestamp = new Date().toISOString();
  return {
    id,
    name,
    type,
    category_id: null,
    position: 0,
    letter,
    created_at: timestamp,
  };
}

describe('workspaceStore channel types', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset();
  });

  afterEach(() => {
    useWorkspaceStore.getState().reset();
  });

  it('sorts channels using the extended channel type order', () => {
    useWorkspaceStore.setState({ selectedRoomSlug: 'alpha', selectedChannelId: null });
    const channels = [
      createChannel(1, 'Stage', 'stage', 'A'),
      createChannel(2, 'Announcements', 'announcements', 'B'),
      createChannel(3, 'Forums', 'forums', 'C'),
      createChannel(4, 'Events', 'events', 'D'),
      createChannel(5, 'Voice', 'voice', 'E'),
      createChannel(6, 'Text', 'text', 'F'),
    ];

    useWorkspaceStore.getState().setChannelsByRoom('alpha', channels);

    const stored = useWorkspaceStore.getState().channelsByRoom['alpha'] ?? [];
    expect(stored.map((channel) => channel.type)).toEqual([
      'text',
      'announcements',
      'forums',
      'events',
      'voice',
      'stage',
    ]);
  });

  it('selects a text-like channel as default when available', () => {
    useWorkspaceStore.setState({ selectedRoomSlug: 'beta', selectedChannelId: null });
    const channels = [
      createChannel(10, 'Main Stage', 'stage', 'A'),
      createChannel(11, 'Updates', 'announcements', 'B'),
    ];

    useWorkspaceStore.getState().setChannelsByRoom('beta', channels);

    expect(useWorkspaceStore.getState().selectedChannelId).toBe(11);
  });
});
