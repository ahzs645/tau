type StaticCodeEditorProps = {
  readonly className?: string;
  readonly value?: string;
  readonly onChange?: (value: string | undefined) => void;
};

export function CodeEditor({ className, value = '', onChange }: StaticCodeEditorProps): React.JSX.Element {
  return (
    <textarea
      className={className}
      spellCheck={false}
      value={value}
      onChange={(event) => {
        onChange?.(event.target.value);
      }}
    />
  );
}
