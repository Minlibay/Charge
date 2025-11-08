import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
  strokeWidth?: number;
}

function BaseIcon({ size = 24, strokeWidth = 1.8, children, ...rest }: IconProps & { children: ReactNode }) {
  const finalProps: IconProps & { 'aria-hidden'?: string } = { ...rest };
  if (!('aria-label' in finalProps) && !('aria-hidden' in finalProps)) {
    finalProps['aria-hidden'] = 'true';
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...finalProps}
    >
      {children}
    </svg>
  );
}

export type IconComponent = (props: IconProps) => JSX.Element;

export const HashIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <line x1="4" y1="9" x2="20" y2="9" />
    <line x1="4" y1="15" x2="20" y2="15" />
    <line x1="10" y1="4" x2="8" y2="20" />
    <line x1="16" y1="4" x2="14" y2="20" />
  </BaseIcon>
);

export const MicIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </BaseIcon>
);

export const StageIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M3 10a9 9 0 0 1 18 0" />
    <path d="M7 10a5 5 0 0 1 10 0" />
    <circle cx="12" cy="17" r="2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </BaseIcon>
);

export const MegaphoneIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M3 11v2a2 2 0 0 0 2 2h2l3 6" />
    <path d="M11 6.5 21 4v16l-10-2.5" />
  </BaseIcon>
);

export const MessagesIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
  </BaseIcon>
);

export const CalendarIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="16" y1="2" x2="16" y2="6" />
  </BaseIcon>
);

export const GripVerticalIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <circle cx="9" cy="5" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="5" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="19" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="19" r="1" fill="currentColor" stroke="none" />
  </BaseIcon>
);

export const EllipsisVerticalIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.25" fill="currentColor" stroke="none" />
  </BaseIcon>
);

export const PlusIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </BaseIcon>
);

export const BellIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </BaseIcon>
);

export const GlobeIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    <path d="M12 2a15.3 15.3 0 0 0-4 10 15.3 15.3 0 0 0 4 10 15.3 15.3 0 0 0 4-10 15.3 15.3 0 0 0-4-10z" />
  </BaseIcon>
);

export const SearchIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <circle cx="11" cy="11" r="7" />
    <line x1="20" y1="20" x2="16.65" y2="16.65" />
  </BaseIcon>
);

export const SunIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="4" />
    <line x1="12" y1="2" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="2" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="22" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </BaseIcon>
);

export const MoonIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </BaseIcon>
);

export const SlidersIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
    <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="18" r="2" fill="currentColor" stroke="none" />
  </BaseIcon>
);

export const UserIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="8" r="4" />
    <path d="M6 20c0-3.314 2.686-6 6-6s6 2.686 6 6" />
  </BaseIcon>
);

export const UserPlusIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="8" r="4" />
    <path d="M6 20c0-3.314 2.686-6 6-6s6 2.686 6 6" />
    <line x1="18" y1="9" x2="22" y2="9" />
    <line x1="20" y1="7" x2="20" y2="11" />
  </BaseIcon>
);

export const LogInIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <polyline points="10 17 15 12 10 7" />
    <line x1="15" y1="12" x2="3" y2="12" />
  </BaseIcon>
);

export const LogOutIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="14 17 9 12 14 7" />
    <line x1="9" y1="12" x2="21" y2="12" />
  </BaseIcon>
);

export const CopyIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </BaseIcon>
);

export const ExternalLinkIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M21 14v7H3V3h7" />
  </BaseIcon>
);

export const ShieldIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M12 3 5 6v6c0 5.25 3.84 9.74 7 11 3.16-1.26 7-5.75 7-11V6z" />
  </BaseIcon>
);

export const TrashIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </BaseIcon>
);

export const MessageCircleIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M21 11.5a8.38 8.38 0 0 1-1.9 5.4 8.5 8.5 0 0 1-6.6 3.1A8.38 8.38 0 0 1 7.1 18L3 19l1.1-4.1A8.38 8.38 0 0 1 3 11.5a8.5 8.5 0 0 1 3.1-6.6 8.38 8.38 0 0 1 5.4-1.9h.5a8.5 8.5 0 0 1 8 8z" />
  </BaseIcon>
);

export const FolderPlusIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M4 4h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </BaseIcon>
);

export const MicOffIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <line x1="2" y1="2" x2="22" y2="22" />
    <path d="M15 12V7a3 3 0 0 0-4.75-2.55" />
    <path d="M9 10v2a3 3 0 0 0 3 3c.7 0 1.36-.24 1.88-.64" />
    <path d="M19 11a7 7 0 0 1-7 7" />
    <path d="M5 11a7 7 0 0 0 2.1 4.9" />
    <path d="M12 18v3" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </BaseIcon>
);

export const HeadphonesIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
  </BaseIcon>
);

export const HeadphonesOffIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <line x1="2" y1="2" x2="22" y2="22" />
    <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
  </BaseIcon>
);

export const VideoIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <rect x="2" y="6" width="18" height="12" rx="2" />
    <path d="m22 10-6-4v8l6-4z" />
  </BaseIcon>
);

export const VideoOffIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <line x1="2" y1="2" x2="22" y2="22" />
    <path d="M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2" />
    <path d="m17 11 4-4v8l-4-4z" />
    <path d="M7 7v13a2 2 0 0 0 2 2h9" />
  </BaseIcon>
);

export const PaperclipIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </BaseIcon>
);

export const SmileIcon: IconComponent = (props) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" y1="9" x2="9.01" y2="9" />
    <line x1="15" y1="9" x2="15.01" y2="9" />
  </BaseIcon>
);