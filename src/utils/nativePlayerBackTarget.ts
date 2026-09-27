export type NativePlayerBackTarget =
  | 'report'
  | 'more'
  | 'subtitle-settings'
  | 'join-party'
  | 'watch-party'
  | 'menu'
  | 'screen-lock'
  | 'none';

export interface NativePlayerBackState {
  reportOpen?: boolean;
  activeMenu?: string | null;
  subtitleSettingsOpen?: boolean;
  joinModalOpen?: boolean;
  watchPartyPanelOpen?: boolean;
  screenLocked?: boolean;
}

export function getNativePlayerBackTarget(state: NativePlayerBackState): NativePlayerBackTarget {
  if (state.reportOpen) return 'report';
  if (state.activeMenu === 'more') return 'more';
  if (state.subtitleSettingsOpen) return 'subtitle-settings';
  if (state.joinModalOpen) return 'join-party';
  if (state.watchPartyPanelOpen) return 'watch-party';
  if (state.activeMenu && state.activeMenu !== 'none') return 'menu';
  if (state.screenLocked) return 'screen-lock';
  return 'none';
}
