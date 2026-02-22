import type { LinkDescriptor } from 'react-router';
import allotmentStylesUrl from 'allotment/dist/style.css?url';
import dockviewStylesUrl from 'dockview-react/dist/styles/dockview.css?url';
import globalStylesUrl from '#styles/global.css?url';

const fonts: LinkDescriptor[] = [
  {
    rel: 'preload',
    href: '/fonts/Geist-Variable.woff2',
    as: 'font',
    type: 'font/woff2',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'preload',
    href: '/fonts/GeistMono-Variable.woff2',
    as: 'font',
    type: 'font/woff2',
    crossOrigin: 'anonymous',
  },
];

const styleSheets: LinkDescriptor[] = [
  {
    rel: 'stylesheet',
    href: allotmentStylesUrl,
  },
  {
    rel: 'stylesheet',
    href: dockviewStylesUrl,
  },
  {
    rel: 'stylesheet',
    href: globalStylesUrl,
  },
];

export const globalStylesLinks: LinkDescriptor[] = [...fonts, ...styleSheets];
