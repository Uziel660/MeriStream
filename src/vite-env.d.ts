/// <reference types="vite/client" />

declare namespace JSX {
  interface IntrinsicElements {
    'google-cast-launcher': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      id?: string;
      style?: any;
    };
  }
}

