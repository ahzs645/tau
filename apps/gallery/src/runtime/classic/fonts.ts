import { loadBinaryFile } from '@taucad/runtime/kernel';

const fontAssets = [
  { name: 'Geist-Regular.ttf', url: new URL('fonts/Geist-Regular.ttf', import.meta.url).href },
  { name: 'Geist-Bold.ttf', url: new URL('fonts/Geist-Bold.ttf', import.meta.url).href },
] as const;

export type ClassicFonts = ReadonlyArray<Readonly<{ name: string; bytes: Uint8Array<ArrayBuffer> }>>;

/** Pinned original font bytes keep text() geometry stable across the gallery migration. */
export const loadClassicFonts = async (): Promise<ClassicFonts> =>
  Promise.all(
    fontAssets.map(async ({ name, url }) => {
      const bytes = await loadBinaryFile(url);
      if (!bytes) {
        throw new Error(`Could not load the OpenSCAD font ${name}.`);
      }
      return { name, bytes: new Uint8Array(bytes) };
    }),
  );

export const classicFontConfiguration = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/fonts</dir>
  <cachedir>/fonts/cache</cachedir>
  <match target="pattern">
    <edit name="family" mode="prepend"><string>Geist</string></edit>
  </match>
</fontconfig>
`;
