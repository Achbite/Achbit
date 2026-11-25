import type { InputHTMLAttributes } from 'react';
import './toggleSwitch.css';

export default function ToggleSwitch(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>) {
  return <span className="settings-switch">
    <input {...props} type="checkbox" role="switch" />
    <span aria-hidden="true" />
  </span>;
}
