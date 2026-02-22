import type { ThreeElements } from '@react-three/fiber';

declare global {
  namespace React {
    namespace JSX {
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions -- This is a valid implementation for Three.js
      interface IntrinsicElements extends ThreeElements {}
    }

    // Add support for CSS variables in CSSProperties.
    // Currently any CSS variables are supported.
    // eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style, @typescript-eslint/consistent-type-definitions, @typescript-eslint/naming-convention -- This is easier to read than a Record.
    interface CSSProperties extends CSS.Properties<string | number> {
      [key: `--${string}`]: string | number;
    }
  }

  // ============ File System Access API Extensions ============
  // These APIs are available in Chrome/Edge but not yet in TypeScript's lib.dom.d.ts.
  // @see https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Extending global interface
  interface FileSystemDirectoryHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  }

  type FileSystemHandlePermissionDescriptor = {
    mode?: 'read' | 'readwrite';
  };

  type DirectoryPickerOptions = {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  };

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Extending global interface
  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
