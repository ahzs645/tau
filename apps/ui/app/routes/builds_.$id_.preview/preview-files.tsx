import { useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';

type FileInfo = {
  path: string;
  name: string;
  size: number;
};

type PreviewFilesProps = {
  readonly files: FileInfo[];
};

export function PreviewFiles({ files }: PreviewFilesProps): React.JSX.Element {
  const renderFileItem = useCallback(
    (index: number) => {
      const file = files[index];
      if (!file) {
        return undefined;
      }

      return (
        <div key={file.path} className="flex items-center justify-between border-b px-4 py-3 last:border-b-0">
          <div className="flex items-center gap-3">
            <FileExtensionIcon filename={file.name} className="size-5 text-muted-foreground" />
            <span className="font-medium">{file.path}</span>
          </div>
          <span className="text-sm text-muted-foreground">{(file.size / 1024).toFixed(2)} KB</span>
        </div>
      );
    },
    [files],
  );

  if (files.length === 0) {
    return <p className="p-6 text-center text-muted-foreground">No files available</p>;
  }

  return (
    <div className="h-full rounded-md border text-sm">
      <Virtuoso totalCount={files.length} itemContent={renderFileItem} className="h-full overflow-y-auto" />
    </div>
  );
}
