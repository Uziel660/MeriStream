import { describe, expect, it } from 'vitest';
import {
  groupByPlayerLanguage,
  normalizePlayerLanguage,
  playerLanguageLabel,
  playerSubtitleLabel,
  sortPlayerLanguageKeys,
} from './playerLanguages';

describe('playerLanguages', () => {
  it('normalizes common provider aliases consistently', () => {
    expect(normalizePlayerLanguage('Español Latino')).toBe('es-419');
    expect(normalizePlayerLanguage('LATAM')).toBe('es-419');
    expect(normalizePlayerLanguage('Castellano')).toBe('es-ES');
    expect(normalizePlayerLanguage('Spanish Spain')).toBe('es-ES');
    expect(normalizePlayerLanguage('Español')).toBe('es');
    expect(normalizePlayerLanguage('JPN')).toBe('ja');
    expect(normalizePlayerLanguage('KOR')).toBe('ko');
    expect(normalizePlayerLanguage('Português Brasil')).toBe('pt-BR');
    expect(normalizePlayerLanguage('zh-CN')).toBe('zh-Hans');
    expect(normalizePlayerLanguage('zh-TW')).toBe('zh-Hant');
  });

  it('does not model dub/sub as languages', () => {
    expect(normalizePlayerLanguage('dub')).toBe('und');
    expect(normalizePlayerLanguage('subtitulado')).toBe('und');
  });

  it('uses readable Spanish labels without collapsing regional variants', () => {
    expect(playerLanguageLabel('es-419')).toBe('Español latino');
    expect(playerLanguageLabel('es-ES')).toBe('Castellano');
    expect(playerLanguageLabel('es')).toBe('Español');
    expect(playerLanguageLabel('ko')).toBe('Coreano');
    expect(playerLanguageLabel('pt-BR')).toBe('Portugués (Brasil)');
  });

  it('sorts preferred languages first and unknown last', () => {
    expect(sortPlayerLanguageKeys(['en', 'und', 'ja', 'es-ES', 'es-419'], ['es-419', 'es-ES', 'ja', 'en']))
      .toEqual(['es-419', 'es-ES', 'ja', 'en', 'und']);
  });

  it('groups tracks without splitting equivalent language aliases', () => {
    const tracks = [
      { id: 1, language: 'Latino' },
      { id: 2, language: 'es-419' },
      { id: 3, language: 'Castellano' },
      { id: 4, language: 'English' },
    ];
    const groups = groupByPlayerLanguage(tracks, (track) => track.language, ['es-419', 'es-ES', 'en']);
    expect(groups.map((group) => [group.language, group.items.length])).toEqual([
      ['es-419', 2],
      ['es-ES', 1],
      ['en', 1],
    ]);
  });

  it('describes forced and SDH subtitles clearly without duplicate provider wording', () => {
    expect(playerSubtitleLabel({ language: 'spa', label: 'Spanish Forced' })).toBe('Español · Forzados');
    expect(playerSubtitleLabel({ language: 'en', hearingImpaired: true })).toBe('Inglés · SDH/CC');
  });
});
