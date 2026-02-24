import { mountWidget } from './widget/mount.js';

// Only mount if we're on a page (not extension pages)
if (document.contentType === 'text/html') {
  mountWidget();
}
