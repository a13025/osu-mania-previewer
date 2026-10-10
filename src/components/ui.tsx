import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn';

// 统一的输入框样式
export const inputCls =
  'h-7 rounded-md border border-zinc-300 bg-white px-2 text-[13px] text-zinc-900 outline-none transition-colors focus:border-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-400';

/** 复选框：勾选显示 ✓，取消为空 */
export function CheckBox({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className="group inline-flex h-6 items-center gap-1.5 text-[13px] text-zinc-800 select-none disabled:cursor-not-allowed disabled:text-zinc-400"
    >
      <span
        className={cn(
          'grid h-[15px] w-[15px] place-items-center rounded-[3px] border bg-white text-[12px] leading-none font-bold transition-colors',
          checked ? 'border-zinc-800 text-zinc-900' : 'border-zinc-400 group-hover:border-zinc-600',
          'group-disabled:border-zinc-300 group-disabled:text-zinc-400',
        )}
      >
        {checked ? '✓' : ''}
      </span>
      {label}
    </button>
  );
}

export function Btn({
  variant = 'default',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 shrink-0 items-center justify-center rounded-md px-3 text-[13px] whitespace-nowrap transition-colors disabled:cursor-not-allowed',
        variant === 'primary'
          ? 'bg-zinc-900 text-white hover:bg-zinc-700 disabled:bg-zinc-300'
          : 'border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 disabled:text-zinc-400 disabled:hover:bg-white',
        className,
      )}
      {...rest}
    />
  );
}

export function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="w-[60px] shrink-0 text-zinc-500">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}
