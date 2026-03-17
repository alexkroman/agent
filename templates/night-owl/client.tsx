import { ChatView, mount, useSession } from "@alexkroman1/aai/ui";

function NightOwl() {
  const { started, start } = useSession();

  if (!started.value) {
    return (
      <div class="flex items-center justify-center h-screen bg-aai-bg font-aai">
        <div class="flex flex-col items-center gap-6 bg-aai-surface border border-aai-border rounded-lg px-12 py-10">
          <div class="text-5xl">&#x1F989;</div>
          <h1 class="text-xl font-semibold text-aai-text m-0">Night Owl</h1>
          <p class="text-sm text-aai-text-muted m-0">your evening companion</p>
          <button
            type="button"
            class="mt-2 px-8 py-3 rounded-aai text-sm font-medium cursor-pointer bg-aai-primary text-white border-none"
            onClick={start}
          >
            Start Conversation
          </button>
        </div>
      </div>
    );
  }

  return <ChatView />;
}

mount(NightOwl);
