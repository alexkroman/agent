import "@alexkroman1/aai-ui/styles.css";
import { ChatView, StartScreen, mount } from "@alexkroman1/aai-ui";

function NightOwl() {
  return (
    <StartScreen icon={<span class="text-5xl">&#x1F989;</span>} title="Night Owl" subtitle="your evening companion" buttonText="Start Conversation">
      <ChatView />
    </StartScreen>
  );
}

mount(NightOwl);
