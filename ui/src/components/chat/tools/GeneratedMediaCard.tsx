import type { ChatMessage } from '../types/types';
import GeneratedImageCard from './GeneratedImageCard';
import GeneratedVideoCard from './GeneratedVideoCard';
export default function GeneratedMediaCard(props: { message: ChatMessage; running: boolean }) {
  return props.message.toolName === 'generate_video' ? <GeneratedVideoCard {...props} /> : <GeneratedImageCard {...props} />;
}
