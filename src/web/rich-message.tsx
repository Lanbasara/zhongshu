import { useMemo, type ComponentProps } from 'react';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { workspaceImages } from './markdown.ts';

/** Loaded only for a visible, finite, completed Markdown preview. */
export default function RichMessage({ text, conversation, item, components, urlTransform }: {
  text: string; conversation: string; item: string;
  components: ComponentProps<typeof Streamdown>['components'];
  urlTransform: ComponentProps<typeof Streamdown>['urlTransform'];
}) {
  const remarkPlugins = useMemo(() => [...Object.values(defaultRemarkPlugins), [workspaceImages, { conversation, item }] as [typeof workspaceImages, { conversation: string; item: string }]], [conversation, item]);
  return <Streamdown plugins={{ code, cjk }} remarkPlugins={remarkPlugins} components={components} skipHtml urlTransform={urlTransform}>{text}</Streamdown>;
}
