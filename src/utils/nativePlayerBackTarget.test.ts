import { describe, expect, it } from 'vitest';
import { getNativePlayerBackTarget } from './nativePlayerBackTarget';

describe('native player Back priority', () => {
  it('closes a report dialog before any underlying More sheet or menu', () => {
    expect(getNativePlayerBackTarget({
      reportOpen: true,
      activeMenu: 'more',
      subtitleSettingsOpen: true,
      joinModalOpen: true,
      watchPartyPanelOpen: true,
      screenLocked: true,
    })).toBe('report');
  });

  it('closes the More sheet before the other player layers', () => {
    expect(getNativePlayerBackTarget({
      reportOpen: false,
      activeMenu: 'more',
      subtitleSettingsOpen: true,
      joinModalOpen: true,
      watchPartyPanelOpen: true,
      screenLocked: true,
    })).toBe('more');
  });

  it('preserves the existing top-to-bottom priority for player-owned layers', () => {
    expect(getNativePlayerBackTarget({ subtitleSettingsOpen: true, activeMenu: 'quality' })).toBe('subtitle-settings');
    expect(getNativePlayerBackTarget({ joinModalOpen: true, watchPartyPanelOpen: true })).toBe('join-party');
    expect(getNativePlayerBackTarget({ watchPartyPanelOpen: true })).toBe('watch-party');
    expect(getNativePlayerBackTarget({ activeMenu: 'servers' })).toBe('menu');
    expect(getNativePlayerBackTarget({ screenLocked: true })).toBe('screen-lock');
    expect(getNativePlayerBackTarget({})).toBe('none');
  });
});
