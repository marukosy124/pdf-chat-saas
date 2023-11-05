import { trpc } from "@/app/_trpc/client";
import { useToast } from "@/components/ui/use-toast";
import { INFINITE_QUERY_LIMIT } from "@/config/infinite-query";
import { useMutation } from "@tanstack/react-query";
import { ReactNode, createContext, useRef, useState } from "react";

type StreamResponse = {
  addMessage: () => void;
  message: string;
  handleInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  isLoading: boolean;
};

export const ChatContext = createContext<StreamResponse>({
  addMessage: () => {},
  message: "",
  handleInputChange: () => {},
  isLoading: false,
});

interface Props {
  fileId: string;
  children: ReactNode;
}

export const ChatContextProvider = ({ fileId, children }: Props) => {
  const [message, setMessage] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const utils = trpc.useContext();

  const { toast } = useToast();

  const backupMessage = useRef("");

  const { mutate: sendMessage } = useMutation({
    mutationFn: async ({ message }: { message: string }) => {
      const response = await fetch("/api/message", {
        method: "POST",
        body: JSON.stringify({
          fileId,
          message,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      return response.body;
    },
    onMutate: async ({ message }) => {
      // backup the sent message and clear the textfield
      backupMessage.current = message;
      setMessage("");

      // cancel any outgoing refetches -> dont override/
      await utils.getFileMessages.cancel();
      // snapshot the prev messages
      const prevMessages = utils.getFileMessages.getInfiniteData();
      // optimistic insert the new value
      utils.getFileMessages.setInfiniteData({ fileId, limit: INFINITE_QUERY_LIMIT }, (old) => {
        if (!old) {
          return { pages: [], pageParams: [] };
        }
        let newPages = [...old.pages];
        let latestPage = newPages[0]!;
        latestPage.messages = [
          {
            createdAt: new Date().toISOString(),
            id: crypto.randomUUID(),
            text: message,
            isUserMessage: true,
          },
          ...latestPage.messages,
        ];
        newPages[0] = latestPage;
        return {
          ...old,
          pages: newPages,
        };
      });

      setIsLoading(true);

      return {
        prevMessages: prevMessages?.pages.flatMap((page) => page.messages) ?? [],
      };
    },
    onSuccess: async (stream) => {
      setIsLoading(false);
      if (!stream) {
        return toast({ title: "There was a problem sending this message", description: "Please refresh this page and try again", variant: "destructive" });
      }

      // stream the response like chatgpt
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let done = false;

      // accumulated response
      let accResponse = "";
      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        const chunkValue = decoder.decode(value);
        accResponse += chunkValue;

        // append chunk to the actual message
        utils.getFileMessages.setInfiniteData(
          {
            fileId,
            limit: INFINITE_QUERY_LIMIT,
          },
          (old) => {
            if (!old) return { pages: [], pageParams: [] };

            let isAiResponseCreated = old.pages.some((page) => page.messages.some((msg) => msg.id === "ai-response"));
            let updatedPages = old.pages.map((page) => {
              // only update the first page (containing the last msg)
              if (page === old.pages[0]) {
                let updatedMessages;
                if (!isAiResponseCreated) {
                  updatedMessages = [{ createdAt: new Date().toISOString(), id: "ai-response", text: accResponse, isUserMessage: false }, ...page.messages];
                } else {
                  updatedMessages = page.messages.map((msg) => {
                    if (msg.id === "ai-response") {
                      return { ...msg, text: accResponse };
                    }
                    return msg;
                  });
                }
                return {
                  ...page,
                  messages: updatedMessages,
                };
              }
              return page;
            });
            return { ...old, pages: updatedPages };
          }
        );
      }
    },
    onError: (_, __, context) => {
      // reset to backup (current) message and prev messages
      setMessage(backupMessage.current);
      utils.getFileMessages.setData({ fileId }, { messages: context?.prevMessages ?? [] });
    },
    onSettled: async () => {
      setIsLoading(false);
      // refresh the entire chat
      await utils.getFileMessages.invalidate({ fileId });
    },
  });

  const addMessage = () => sendMessage({ message });

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
  };

  return <ChatContext.Provider value={{ addMessage, message, handleInputChange, isLoading }}>{children}</ChatContext.Provider>;
};
