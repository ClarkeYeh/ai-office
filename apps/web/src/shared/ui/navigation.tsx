import { createContext, useContext, type AnchorHTMLAttributes } from 'react';
export interface Navigation {
  navigate: (href: string, options?: { replace?: boolean }) => void;
}
export const NavigationContext = createContext<Navigation | null>(null);
export function useNavigation(): Navigation {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('Navigation provider is missing');
  return value;
}
export function Link({
  href,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  'aria-label': string;
  'data-testid': string;
}) {
  const navigation = useContext(NavigationContext);
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          !navigation ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.target ||
          props.download !== undefined ||
          !href.startsWith('/') ||
          href.startsWith('//')
        )
          return;
        event.preventDefault();
        navigation.navigate(href);
      }}
    />
  );
}
