import type { Meta, StoryObj } from '@storybook/react-vite';
function Reference() { return <><p style={{ padding:12,fontSize:12 }}>已认可的历史原型。这里的执行和文件均为模拟；产品不依赖这份代码。</p><iframe title="认可原型" src="/reference/index.html" sandbox="allow-scripts allow-modals" style={{ border:0,width:'100%',height:'calc(100dvh - 44px)' }}/></>; }
export default {title:'设计参考/认可原型',component:Reference} satisfies Meta<typeof Reference>;
export const Accepted: StoryObj<typeof Reference> = {};
