import { createRoot } from 'react-dom/client';
import { App } from '#app.jsx';
import '#styles.css';

const root = document.querySelector('#root');
if (!root) {
  throw new Error('The gallery root element is missing.');
}
createRoot(root).render(<App />);
