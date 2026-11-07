import type { Preview } from '@storybook/react-vite';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';
import { UIProvider } from '../src/web/ui/provider.tsx';
import '../src/web/style.css';
import '../src/web/workbench.css';

const preview: Preview = {
  decorators: [Story => <UIProvider><Story/></UIProvider>],
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    // `phone` matches the product's narrow breakpoint (max-width 759px), so media queries and useNarrow switch for real.
    viewport: { options: { phone: { name: '手机 390×844', styles: { width: '390px', height: '844px' }, type: 'mobile' }, ...MINIMAL_VIEWPORTS } },
    options: {
      storySort: {
        order: ['设计基础', '基础', '模式', ['工作台框架', '侧栏', '搜索与跳转', '提示', '对话内容', '过程展示', '本轮文件', '输入框', '新对话', '子 Agent', '插件库'], '工作台'],
      },
    },
  },
};
export default preview;
