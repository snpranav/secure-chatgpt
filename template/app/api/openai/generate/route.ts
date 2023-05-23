import {
  NextRequestWithAuth,
  extractURLs,
  getAvailableTokens,
  withAPIAuthentication,
} from "../../../../utils";
import { Configuration, OpenAIApi } from "openai";
import { audit, redact, domainIntel, urlIntel } from "../../../../utils/pangea";

const shouldRedact = process.env.OPTIONS_REDACT_USER_PROMPTS === "true";
const shouldAudit = process.env.OPTIONS_AUDIT_USER_PROMPTS === "true";
const shouldThreatAnalyse =
  process.env.OPTIONS_THREAT_ANALYSE_SERVICE_RESPONSES === "true";

  const SOURCE = "pangea-secure-chatgpt";
  const TARGET_MODEL = "text-davinci-003";
  const ACTION = "openai_generate";

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

// return true or false based on the reputation service response
const isMalicious = async (url) => {
  const urlIntelResponse = await urlIntel.reputation(url, {
    provider: "crowdstrike",
  });

  const domain = new URL(url).hostname.replace("www.", "");
  const domainIntelResponse = await domainIntel.reputation(domain, {
    provider: "crowdstrike",
  });

  // If it is malicious, we should redact it
  if (
    urlIntelResponse?.result?.data?.verdict === "malicious" ||
    domainIntelResponse?.result?.data?.verdict === "malicious"
  ) {
    return true;
  }
  return false;
};

const handler = async (req: NextRequestWithAuth) => {
  if (!configuration.apiKey) {
    return new Response("The service cannot communicate with OpenAI", {
      status: 500,
    });
  }

  const userID = req.__userSession?.tokenDetails?.identity;
  const actor = req.__userSession?.tokenDetails?.email || userID;

  const body = await req.json();
  const prompt = body?.prompt?.trim() || "";
  const prompt_id = body?.prompt_id || "";

  if (prompt.length === 0) {
    return new Response("Please enter a valid prompt", { status: 400 });
  }

  try {
    // we start with the original prompt and update it based on the options
    let processedPrompt = prompt;

    // We should redact the user prompt before sending it to OpenAI
    if (shouldRedact) {
      const redactResponse = await redact.redact(processedPrompt);
      processedPrompt = redactResponse?.result?.redacted_text || "";
    }

    // We should audit the user prompt in redacted format
    if (shouldAudit) {
      const auditData = {
        action: ACTION,
        actor: actor,
        message: processedPrompt,
        source: SOURCE,
        target: TARGET_MODEL,
      };

      await audit.log(auditData);
    }

    // Call OpenAI API with the processed prompt
    const completion = await openai.createCompletion({
      model: TARGET_MODEL,
      prompt: processedPrompt,
      temperature: 0.7,
      max_tokens: getAvailableTokens(processedPrompt),
    });

    let sanitizedResponse = completion.data?.choices?.[0]?.text || "";

    const maliciousURLs = [];

    // We should process the OpenAI response thru the reputation services
    // We currently check URL reputation and domain reputation
    if (shouldThreatAnalyse) {
      const urls = extractURLs(sanitizedResponse) || [];
      // De-fang all the malicious URLs and domains
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        if (await isMalicious(url)) {
          const defangedURL = url.replace("http", "hxxp");
          maliciousURLs.push(defangedURL);
          sanitizedResponse = sanitizedResponse.replaceAll(url, defangedURL);
        }
      }
    }

    const responseData = { prompt: processedPrompt, prompt_id, result: sanitizedResponse, maliciousURLs };

    return new Response(
      JSON.stringify(responseData),
      {
        headers: { "content-type": "application/json" },
      }
    );
  } catch (error) {
    if (error.response) {
      console.error(error.response.status, error.response.data);
      return new Response("An error occurred during your request.", {
        status: 400,
      });
    } else {
      console.error(`Error with OpenAI API request: ${error.message}`);
      return new Response("An error occurred during your request.", {
        status: 500,
      });
    }
  }
};

export const POST = withAPIAuthentication(handler);
