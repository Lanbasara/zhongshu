import type { Preview } from '@storybook/react-vite';
import { UIProvider } from '../src/web/ui/provider.tsx';
import '../src/web/style.css';
import '../src/web/workbench.css';
const preview: Preview = { decorators: [Story => <UIProvider><Story/></UIProvider>], parameters: { layout: 'fullscreen', controls: { expanded: true } } };
export default preview;
