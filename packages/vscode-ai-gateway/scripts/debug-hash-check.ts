import { computeNormalizedDigest } from "../src/utils/digest";
import {
  LanguageModelChatMessage,
  LanguageModelChatMessageRole,
} from "../src/models";

const userMessage: LanguageModelChatMessage = {
  role: LanguageModelChatMessageRole.User,
  content: [{ type: "text", value: "Test Message 4" }],
  name: undefined,
};

const hash = computeNormalizedDigest(userMessage);
console.log(`Hash of "Test Message 4": ${hash}`);

const userMessage2: LanguageModelChatMessage = {
  role: LanguageModelChatMessageRole.User,
  content: [{ type: "text", value: "Test Message 4\n" }],
  name: undefined,
};
console.log(
  `Hash of "Test Message 4\\n": ${computeNormalizedDigest(userMessage2)}`,
);
