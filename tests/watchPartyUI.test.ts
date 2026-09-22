/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { WatchPartyPanel } from '../src/components/WatchPartyPanel';
import { WatchPartyJoinModal } from '../src/components/WatchPartyJoinModal';
import type {
  WatchPartyRoom,
  WatchPartyParticipant,
  WatchPartyChatMessage,
  WatchPartyReaction,
} from '../src/hooks/useTeleparty';

describe('Watch Party UI Components (R4)', () => {
  afterEach(() => {
    cleanup();
  });
  const mockParticipants: WatchPartyParticipant[] = [
    {
      userId: 'user-host-1',
      username: 'HostUser',
      isHost: true,
      joinedAt: 1000,
    },
    {
      userId: 'user-viewer-2',
      username: 'ViewerUser',
      isHost: false,
      joinedAt: 2000,
    },
  ];

  const mockRoom: WatchPartyRoom = {
    roomCode: 'PARTY7',
    hostId: 'user-host-1',
    hostUsername: 'HostUser',
    media: {
      title: 'Inception',
      kind: 'movie',
      posterUrl: 'https://example.com/inception.jpg',
      streamUrl: 'https://example.com/stream.m3u8',
    },
    isPlaying: true,
    currentTime: 120,
    playbackRate: 1.0,
    updatedAt: Date.now(),
    participantCount: 2,
    participants: mockParticipants,
    createdAt: Date.now() - 50000,
  };

  const mockMessages: WatchPartyChatMessage[] = [
    {
      id: 'msg-1',
      userId: 'user-host-1',
      username: 'HostUser',
      text: '¡Bienvenidos a la Watch Party!',
      isEmoji: false,
      timestamp: Date.now() - 10000,
    },
    {
      id: 'msg-2',
      userId: 'user-viewer-2',
      username: 'ViewerUser',
      text: '🎉',
      isEmoji: true,
      timestamp: Date.now() - 5000,
    },
  ];

  const mockReactions: WatchPartyReaction[] = [
    {
      id: 'rx-1',
      emoji: '🔥',
      userId: 'user-viewer-2',
      username: 'ViewerUser',
      timestamp: Date.now() - 2000,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. WatchPartyPanel Component', () => {
    it('renders room code, participant count, and messages when open', () => {
      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: vi.fn(),
          sendReaction: vi.fn(),
        })
      );

      // Verify panel container
      expect(screen.getByTestId('watch-party-panel')).toBeDefined();

      // Verify room code displayed
      const codeDisplay = screen.getByTestId('room-code-display');
      expect(codeDisplay.textContent).toBe('PARTY7');

      // Verify participant count pill
      const countEl = screen.getByTestId('participant-count');
      expect(countEl.textContent).toBe('2');

      // Verify messages rendered
      expect(screen.getByText('¡Bienvenidos a la Watch Party!')).toBeDefined();
      expect(screen.getAllByText('🎉').length).toBeGreaterThanOrEqual(1);
    });

    it('does not render when isOpen is false', () => {
      const { container } = render(
        React.createElement(WatchPartyPanel, {
          isOpen: false,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: vi.fn(),
          sendReaction: vi.fn(),
        })
      );

      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId('watch-party-panel')).toBeNull();
    });

    it('copies room code to clipboard and provides visual "¡Copiado!" feedback', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: {
          writeText: writeTextMock,
        },
      });

      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: vi.fn(),
          sendReaction: vi.fn(),
        })
      );

      const copyBtn = screen.getByTestId('copy-code-button');
      fireEvent.click(copyBtn);

      expect(writeTextMock).toHaveBeenCalledWith('PARTY7');

      // Visual feedback "¡Copiado!" should appear
      await waitFor(() => {
        expect(screen.getByText('¡Copiado!')).toBeDefined();
      });
    });

    it('toggles participant drawer showing usernames and host badge (👑 Anfitrión)', () => {
      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: vi.fn(),
          sendReaction: vi.fn(),
        })
      );

      // Initially participant list is collapsed
      expect(screen.queryByTestId('participants-list')).toBeNull();

      // Click toggle
      const toggleBtn = screen.getByTestId('toggle-participants-button');
      fireEvent.click(toggleBtn);

      // Now participant list is visible
      const list = screen.getByTestId('participants-list');
      expect(list).toBeDefined();
      expect(screen.getAllByText(/HostUser/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/ViewerUser/).length).toBeGreaterThanOrEqual(1);

      // Host badge check
      const hostBadge = screen.getByTestId('host-badge');
      expect(hostBadge.textContent).toContain('Anfitrión');
      expect(hostBadge.textContent).toContain('👑');
    });

    it('displays "Controlado por el anfitrión" when user is viewer (isHost: false)', () => {
      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: false,
          sendMessage: vi.fn(),
          sendReaction: vi.fn(),
        })
      );

      const banner = screen.getByTestId('viewer-indicator-banner');
      expect(banner).toBeDefined();
      expect(banner.textContent).toContain('Controlado por el anfitrión');
      expect(banner.textContent).toContain('HostUser');
    });

    it('does NOT display viewer indicator banner when user is host (isHost: true)', () => {
      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: vi.fn(),
          sendReaction: vi.fn(),
        })
      );

      expect(screen.queryByTestId('viewer-indicator-banner')).toBeNull();
    });

    it('submits chat message via button click and clears input field', () => {
      const sendMessageMock = vi.fn();

      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: sendMessageMock,
          sendReaction: vi.fn(),
        })
      );

      const input = screen.getByTestId('chat-text-input') as HTMLInputElement;
      const sendBtn = screen.getByTestId('send-message-button');

      // Button is initially disabled when input is empty
      expect(sendBtn.hasAttribute('disabled')).toBe(true);

      // Type text
      fireEvent.change(input, { target: { value: '¡Excelente película!' } });
      expect(input.value).toBe('¡Excelente película!');
      expect(sendBtn.hasAttribute('disabled')).toBe(false);

      // Click send
      fireEvent.click(sendBtn);

      expect(sendMessageMock).toHaveBeenCalledWith('¡Excelente película!', false);
      expect(input.value).toBe('');
    });

    it('submits chat message via Enter key', () => {
      const sendMessageMock = vi.fn();

      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: sendMessageMock,
          sendReaction: vi.fn(),
        })
      );

      const input = screen.getByTestId('chat-text-input') as HTMLInputElement;

      fireEvent.change(input, { target: { value: 'Hola a todos' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

      expect(sendMessageMock).toHaveBeenCalledWith('Hola a todos', false);
      expect(input.value).toBe('');
    });

    it('sends instant reactions when quick emoji buttons are clicked', () => {
      const sendReactionMock = vi.fn();

      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: vi.fn(),
          sendReaction: sendReactionMock,
        })
      );

      const emojis = ['❤️', '😂', '😮', '👏', '🔥', '🎉'];
      for (const emoji of emojis) {
        const btn = screen.getByTestId(`quick-emoji-${emoji}`);
        expect(btn).toBeDefined();
        fireEvent.click(btn);
        expect(sendReactionMock).toHaveBeenCalledWith(emoji);
      }
    });

    it('triggers leave room callback and close button callback', () => {
      const leaveMock = vi.fn();
      const closeMock = vi.fn();

      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: closeMock,
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: true,
          sendMessage: vi.fn(),
          sendReaction: vi.fn(),
          onLeaveRoom: leaveMock,
        })
      );

      const leaveBtn = screen.getByTestId('leave-room-button');
      fireEvent.click(leaveBtn);
      expect(leaveMock).toHaveBeenCalledTimes(1);

      const closeBtn = screen.getByTestId('close-panel-button');
      fireEvent.click(closeBtn);
      expect(closeMock).toHaveBeenCalledTimes(1);
    });

    it('supports mobile viewport <=360px without horizontal overflow', () => {
      // Simulate mobile window
      window.innerWidth = 320;
      window.dispatchEvent(new Event('resize'));

      render(
        React.createElement(WatchPartyPanel, {
          isOpen: true,
          onClose: vi.fn(),
          room: mockRoom,
          participants: mockParticipants,
          messages: mockMessages,
          reactions: mockReactions,
          isHost: false,
          sendMessage: vi.fn(),
          sendReaction: vi.fn(),
        })
      );

      const panel = screen.getByTestId('watch-party-panel');
      expect(panel).toBeDefined();
      // Verify mobile classes include max-w-full and overflow-x-hidden
      expect(panel.className).toContain('max-w-full');
      expect(panel.className).toContain('overflow-x-hidden');
    });
  });

  describe('2. WatchPartyJoinModal Component', () => {
    it('renders modal dialog with tabs when isOpen is true', () => {
      render(
        React.createElement(WatchPartyJoinModal, {
          isOpen: true,
          onClose: vi.fn(),
          onJoin: vi.fn(),
          media: { title: 'Inception' },
        })
      );

      expect(screen.getByTestId('watch-party-join-modal')).toBeDefined();
      expect(screen.getByTestId('tab-create-room')).toBeDefined();
      expect(screen.getByTestId('tab-join-room')).toBeDefined();
      expect(screen.getByText('Inception')).toBeDefined();
    });

    it('does not render when isOpen is false', () => {
      const { container } = render(
        React.createElement(WatchPartyJoinModal, {
          isOpen: false,
          onClose: vi.fn(),
          onJoin: vi.fn(),
        })
      );

      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId('watch-party-join-modal')).toBeNull();
    });

    it('handles "Crear Sala" submission via onCreateRoom callback', async () => {
      const createMock = vi.fn().mockResolvedValue('NEW123');
      const joinMock = vi.fn();
      const closeMock = vi.fn();

      render(
        React.createElement(WatchPartyJoinModal, {
          isOpen: true,
          onClose: closeMock,
          onJoin: joinMock,
          onCreateRoom: createMock,
          media: { title: 'Attack on Titan', kind: 'anime' },
        })
      );

      const createBtn = screen.getByTestId('create-room-submit-button');
      fireEvent.click(createBtn);

      await waitFor(() => {
        expect(createMock).toHaveBeenCalled();
        expect(joinMock).toHaveBeenCalledWith('NEW123');
        expect(closeMock).toHaveBeenCalled();
      });
    });

    it('handles "Unirse a Sala" tab switching, code sanitization (auto-uppercase, max 6), and submission', async () => {
      const joinMock = vi.fn();
      const closeMock = vi.fn();

      render(
        React.createElement(WatchPartyJoinModal, {
          isOpen: true,
          onClose: closeMock,
          onJoin: joinMock,
          onJoinRoom: vi.fn().mockResolvedValue(undefined),
        })
      );

      // Switch to Join tab
      const joinTab = screen.getByTestId('tab-join-room');
      fireEvent.click(joinTab);

      const codeInput = screen.getByTestId('room-code-input') as HTMLInputElement;
      const submitBtn = screen.getByTestId('join-room-submit-button');

      // Submit button is disabled before 6 chars
      expect(submitBtn.hasAttribute('disabled')).toBe(true);

      // Input lowercase alphanumeric with special chars: should sanitize to uppercase alphanumeric, max 6
      fireEvent.change(codeInput, { target: { value: 'ab-c!123456' } });
      expect(codeInput.value).toBe('ABC123');
      expect(submitBtn.hasAttribute('disabled')).toBe(false);

      // Submit form
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(joinMock).toHaveBeenCalledWith('ABC123');
        expect(closeMock).toHaveBeenCalled();
      });
    });

    it('displays error message when room code is not found or fails validation', async () => {
      const joinRoomMock = vi.fn().mockRejectedValue(new Error('La sala especificada no existe o ha expirado.'));

      render(
        React.createElement(WatchPartyJoinModal, {
          isOpen: true,
          onClose: vi.fn(),
          onJoin: vi.fn(),
          onJoinRoom: joinRoomMock,
        })
      );

      // Switch to Join tab
      fireEvent.click(screen.getByTestId('tab-join-room'));

      const codeInput = screen.getByTestId('room-code-input');
      fireEvent.change(codeInput, { target: { value: 'XYZ999' } });

      const submitBtn = screen.getByTestId('join-room-submit-button');
      fireEvent.click(submitBtn);

      await waitFor(() => {
        const errorAlert = screen.getByTestId('modal-error-message');
        expect(errorAlert).toBeDefined();
        expect(errorAlert.textContent).toContain('La sala especificada no existe');
      });
    });

    it('closes on Escape key press or close button click', () => {
      const closeMock = vi.fn();

      render(
        React.createElement(WatchPartyJoinModal, {
          isOpen: true,
          onClose: closeMock,
          onJoin: vi.fn(),
        })
      );

      const closeBtn = screen.getByTestId('close-modal-button');
      fireEvent.click(closeBtn);
      expect(closeMock).toHaveBeenCalledTimes(1);

      // Escape key
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(closeMock).toHaveBeenCalledTimes(2);
    });
  });
});
