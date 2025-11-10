import { useTranslation } from 'react-i18next';

interface RoleColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

const DEFAULT_COLORS = [
  '#FF5733', '#33FF57', '#3357FF', '#FF33F5', '#F5FF33',
  '#33FFF5', '#FF8C33', '#8C33FF', '#33FF8C', '#FF338C',
  '#99AAB5', '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
];

export function RoleColorPicker({ value, onChange }: RoleColorPickerProps): JSX.Element {
  const { t } = useTranslation();

  const handleHexInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    if (/^#[0-9A-F]{0,6}$/.test(val)) {
      onChange(val);
    }
  };

  return (
    <div className="role-color-picker">
      <label className="role-color-picker__label">
        {t('roles.color', { defaultValue: 'Цвет' })}
      </label>
      <div className="role-color-picker__container">
        <div className="role-color-picker__palette">
          {DEFAULT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`role-color-picker__swatch ${value === color ? 'role-color-picker__swatch--selected' : ''}`}
              onClick={() => onChange(color)}
              style={{ backgroundColor: color }}
              aria-label={color}
              title={color}
            />
          ))}
        </div>
        <div className="role-color-picker__inputs">
          <input
            type="color"
            className="role-color-picker__color-input"
            value={value}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            aria-label={t('roles.colorPicker', { defaultValue: 'Выбрать цвет' })}
          />
          <input
            type="text"
            className="role-color-picker__hex-input"
            value={value}
            onChange={handleHexInput}
            pattern="^#[0-9A-F]{6}$"
            placeholder="#000000"
            maxLength={7}
            aria-label={t('roles.hexColor', { defaultValue: 'HEX цвет' })}
          />
        </div>
        <div className="role-color-picker__preview">
          <div
            className="role-color-picker__preview-badge"
            style={{ '--role-color': value } as React.CSSProperties}
          >
            {t('roles.preview', { defaultValue: 'Предпросмотр' })}
          </div>
        </div>
      </div>
    </div>
  );
}

