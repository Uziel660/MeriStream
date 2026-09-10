import { useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { APP_PREFERENCES_EVENT, applyAppPreferencesToDocument } from '../utils/appPreferences';

/** Keeps presentation-only preferences attached to the active profile. */
export function InterfaceStyleBridge() {
  const { user } = useAuth();

  useEffect(() => {
    const apply = () => applyAppPreferencesToDocument(user?.id);
    apply();
    window.addEventListener(APP_PREFERENCES_EVENT, apply);
    return () => window.removeEventListener(APP_PREFERENCES_EVENT, apply);
  }, [user?.id]);

  return null;
}
