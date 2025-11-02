import { cloneElement, isValidElement, ReactNode, useId } from 'react';

interface ServerTooltipProps {
  label: string;
  children: ReactNode;
}

export function ServerTooltip({ label, children }: ServerTooltipProps): JSX.Element {
  const tooltipId = useId();
  if (!isValidElement(children)) {
    return (
      <div className="server-tooltip">
        {children}
        <span role="tooltip" id={tooltipId} className="server-tooltip__content">
          {label}
        </span>
      </div>
    );
  }

  const existingDescribedBy = (children.props as { 'aria-describedby'?: string })['aria-describedby'];
  const describedBy = [existingDescribedBy, tooltipId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="server-tooltip">
      {cloneElement(children, {
        ...children.props,
        'aria-describedby': describedBy,
      })}
      <span role="tooltip" id={tooltipId} className="server-tooltip__content">
        {label}
      </span>
    </div>
  );
}
