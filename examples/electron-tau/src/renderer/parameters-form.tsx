/** Single row consumed by {@link ParametersForm}; mapped from runtime `parametersResolved`. */
export type ParametersFormRow = {
  readonly name: string;
  readonly defaultValue: number | string;
};

export type ParametersFormProperties = {
  readonly params: readonly ParametersFormRow[];
  readonly override?: { name: string; value: number };
  readonly onChange: (name: string, value: number) => void;
};

export function ParametersForm({ params, override, onChange }: ParametersFormProperties): React.ReactElement {
  if (params.length === 0) {
    return (
      <p data-testid='parameters-empty' style={emptyStyles}>
        No parameters detected.
      </p>
    );
  }

  return (
    <ul data-testid='parameters-list' style={listStyles}>
      {params.map((parameter) => {
        const numericDefault = typeof parameter.defaultValue === 'number' ? parameter.defaultValue : 0;
        const value = override?.name === parameter.name ? override.value : numericDefault;
        return (
          <li key={parameter.name} style={rowStyles}>
            <label
              htmlFor={`param-${parameter.name}`}
              data-testid={`param-label-${parameter.name}`}
              style={labelStyles}
            >
              {parameter.name}
            </label>
            <input
              id={`param-${parameter.name}`}
              data-testid={`param-input-${parameter.name}`}
              type='number'
              value={value}
              onChange={(event) => {
                onChange(parameter.name, Number(event.target.value));
              }}
              style={inputStyles}
            />
          </li>
        );
      })}
    </ul>
  );
}

const emptyStyles: React.CSSProperties = {
  fontSize: '0.85rem',
  // oxlint-disable-next-line tau-lint/no-hardcoded-color -- standalone Electron PoC: no design-token system, inline-only React style sheet
  color: '#777',
};

const listStyles: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
};

const rowStyles: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

const labelStyles: React.CSSProperties = {
  flex: '0 0 40%',
  fontSize: '0.85rem',
  fontFamily: 'ui-monospace, monospace',
};

const inputStyles: React.CSSProperties = {
  flex: 1,
  fontSize: '0.85rem',
  padding: '0.25rem 0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
};
