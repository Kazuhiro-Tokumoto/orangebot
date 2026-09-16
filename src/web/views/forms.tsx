import type { Child } from 'hono/jsx';

/** 画面をまたいで使う小さな部品。見た目は layout.tsx の CSS に寄せてある。 */

export function Notice({ tone, children }: { tone: 'ok' | 'bad' | 'warn'; children: Child }) {
  return <div class={`banner ${tone === 'warn' ? 'bad' : tone}`}>{children}</div>;
}

export function Field(props: {
  readonly label: string;
  readonly name: string;
  readonly type?: string | undefined;
  readonly value?: string | undefined;
  readonly hint?: string | undefined;
  readonly required?: boolean | undefined;
  readonly autocomplete?: string | undefined;
  readonly inputmode?: 'numeric' | 'text' | 'tel' | 'email' | 'url' | 'search' | 'decimal' | 'none' | undefined;
  readonly placeholder?: string | undefined;
}) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <input
        class="input"
        name={props.name}
        type={props.type ?? 'text'}
        value={props.value ?? ''}
        required={props.required ?? false}
        autocomplete={props.autocomplete ?? 'off'}
        inputmode={props.inputmode}
        placeholder={props.placeholder}
      />
      {props.hint === undefined ? null : <span class="field-hint">{props.hint}</span>}
    </label>
  );
}

export function TextArea(props: {
  readonly label: string;
  readonly name: string;
  readonly hint?: string | undefined;
  readonly rows?: number | undefined;
}) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <textarea class="input" name={props.name} rows={props.rows ?? 3} />
      {props.hint === undefined ? null : <span class="field-hint">{props.hint}</span>}
    </label>
  );
}

export function Select(props: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly value?: string | undefined;
  readonly hint?: string | undefined;
}) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <select class="input" name={props.name}>
        {props.options.map((option) => (
          <option value={option.value} selected={option.value === props.value}>
            {option.label}
          </option>
        ))}
      </select>
      {props.hint === undefined ? null : <span class="field-hint">{props.hint}</span>}
    </label>
  );
}

export function Submit({ children, tone }: { children: Child; tone?: 'danger' }) {
  return (
    <button class={`btn ${tone === 'danger' ? 'danger' : ''}`} type="submit">
      {children}
    </button>
  );
}

/** 一度しか見せない値を、写し取りやすい形で出す。 */
export function SecretBox({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <section class="panel secret">
      <div class="field-label">{label}</div>
      <ol class="secret-list">
        {values.map((value) => (
          <li class="mono">{value}</li>
        ))}
      </ol>
    </section>
  );
}
