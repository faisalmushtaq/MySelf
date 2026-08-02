"""
Custom chat input with paste detection and typing-trace capture.
"""

import base64
import json

import streamlit as st

PASTE_MARKER = "\u200B\u200C\u200D"
TRACE_PREFIX = "\u2060\u2061\u2062"
TRACE_SUFFIX = "\u2062\u2061\u2060"
TRACE_ZERO = "\u200B"
TRACE_ONE = "\u200C"
TRACE_BASE64_ALPHABET = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
)


def chat_input_with_paste_detection(
    placeholder="Type your message here...",
    key=None,
    disabled=False,
):
    """
    Render a chat input that records paste use and a lightweight typing trace.

    Returns:
        dict | None: {
            "message": str,
            "isPasted": bool,
            "typingTrace": list,
            "traceVersion": int,
            "traceTruncated": bool,
        }
    """

    paste_key = f"paste_{key}" if key else "paste_default"

    html_code = f"""
    <script>
    (function() {{
        const parentWindow = window.parent;
        const parentDoc = parentWindow.document;

        if (!parentWindow._currentPaste) {{
            parentWindow._currentPaste = {{}};
        }}

        if (!parentWindow._currentPaste['{paste_key}']) {{
            parentWindow._currentPaste['{paste_key}'] = {{
                hasPasted: false,
                submitted: false,
                inputTrace: [],
                traceStartMs: null,
                traceTruncated: false
            }};
        }}

        if (parentWindow._currentPaste['{paste_key}'].submitted) {{
            parentWindow._currentPaste['{paste_key}'] = {{
                hasPasted: false,
                submitted: false,
                inputTrace: [],
                traceStartMs: null,
                traceTruncated: false
            }};
        }}

        const currentPaste = parentWindow._currentPaste['{paste_key}'];
        const PASTE_MARKER = '\\u200B\\u200C\\u200D';
        const TRACE_PREFIX = '{TRACE_PREFIX}';
        const TRACE_SUFFIX = '{TRACE_SUFFIX}';
        const TRACE_ZERO = '{TRACE_ZERO}';
        const TRACE_ONE = '{TRACE_ONE}';
        const TRACE_BASE64_ALPHABET = '{TRACE_BASE64_ALPHABET}';
        const MAX_TRACE_EVENTS = 2500;

        function setInputValue(input, newValue) {{
            const setter = Object.getOwnPropertyDescriptor(
                parentWindow.HTMLTextAreaElement.prototype,
                'value'
            )?.set;
            if (setter) {{
                setter.call(input, newValue);
            }} else {{
                input.value = newValue;
            }}
        }}

        function dispatchInputEvent(input) {{
            try {{
                const inputEvent = new InputEvent('input', {{
                    bubbles: true,
                    cancelable: false,
                    inputType: 'insertText',
                    data: null
                }});
                input.dispatchEvent(inputEvent);
            }} catch (err) {{
                const inputEvent = new Event('input', {{ bubbles: true }});
                input.dispatchEvent(inputEvent);
            }}
        }}

        function injectMarkerIfNeeded(input) {{
            if (!input || !currentPaste.hasPasted) return;

            const currentValue = input.value || '';
            if (!currentValue || currentValue.startsWith(PASTE_MARKER)) return;

            const start = input.selectionStart || 0;
            const end = input.selectionEnd || 0;

            setInputValue(input, PASTE_MARKER + currentValue);
            try {{
                input.setSelectionRange(
                    start + PASTE_MARKER.length,
                    end + PASTE_MARKER.length
                );
            }} catch (err) {{}}

            dispatchInputEvent(input);
        }}

        function encodePayload(payloadObj) {{
            try {{
                const jsonText = JSON.stringify(payloadObj);
                return parentWindow
                    .btoa(unescape(encodeURIComponent(jsonText)))
                    .replace(/=+$/g, '');
            }} catch (err) {{
                return null;
            }}
        }}

        function toInvisiblePayload(base64Text) {{
            let bits = '';
            for (const ch of base64Text) {{
                const idx = TRACE_BASE64_ALPHABET.indexOf(ch);
                if (idx < 0) continue;
                bits += idx.toString(2).padStart(6, '0');
            }}

            let encoded = '';
            for (const bit of bits) {{
                encoded += bit === '1' ? TRACE_ONE : TRACE_ZERO;
            }}
            return encoded;
        }}

        function resetTraceState() {{
            currentPaste.inputTrace = [];
            currentPaste.traceStartMs = null;
            currentPaste.traceTruncated = false;
            currentPaste.hasPasted = false;
            currentPaste.submitted = true;
        }}

        function injectTraceIfNeeded(input) {{
            if (!input) return;

            const currentValue = input.value || '';
            if (!currentValue || currentValue.includes(TRACE_PREFIX)) return;

            const payload = encodePayload({{
                v: 1,
                t: currentPaste.inputTrace || [],
                tt: !!currentPaste.traceTruncated
            }});

            if (!payload) return;

            const invisiblePayload = toInvisiblePayload(payload);
            setInputValue(
                input,
                currentValue + TRACE_PREFIX + invisiblePayload + TRACE_SUFFIX
            );
            dispatchInputEvent(input);
        }}

        function finalizeSubmission(input) {{
            injectMarkerIfNeeded(input);
            injectTraceIfNeeded(input);
            resetTraceState();
        }}

        function getSubmitButtonNearInput(input) {{
            const chatContainer = input.closest('div[data-testid="stChatInput"]');
            if (!chatContainer) return null;
            return chatContainer.querySelector(
                'button[data-testid="stChatInputSubmitButton"], button[type="submit"]'
            );
        }}

        function setupInput(input) {{
            const bindingKey = '_pasteBound_{paste_key}';
            if (input[bindingKey]) return;
            input[bindingKey] = true;

            const pasteHandler = function() {{
                currentPaste.hasPasted = true;
            }};

            const inputHandler = function(event) {{
                if (!event.isTrusted) return;

                const now = Date.now();
                if (currentPaste.traceStartMs === null) {{
                    currentPaste.traceStartMs = now;
                }}

                if ((currentPaste.inputTrace || []).length >= MAX_TRACE_EVENTS) {{
                    currentPaste.traceTruncated = true;
                    return;
                }}

                const value = input.value || '';
                const cleanLen = value.startsWith(PASTE_MARKER)
                    ? Math.max(0, value.length - PASTE_MARKER.length)
                    : value.length;

                currentPaste.inputTrace.push({{
                    t_ms: Math.max(0, now - currentPaste.traceStartMs),
                    e: 'input',
                    len: cleanLen
                }});
            }};

            const keydownHandler = function(e) {{
                if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
                finalizeSubmission(input);
            }};

            const button = getSubmitButtonNearInput(input);
            const buttonPointerHandler = function() {{
                finalizeSubmission(input);
            }};
            const buttonClickHandler = function() {{
                finalizeSubmission(input);
            }};

            input.addEventListener('paste', pasteHandler, true);
            input.addEventListener('input', inputHandler, true);
            input.addEventListener('keydown', keydownHandler, true);

            if (button) {{
                button.addEventListener('pointerdown', buttonPointerHandler, true);
                button.addEventListener('click', buttonClickHandler, true);
            }}
        }}

        function setupAllInputs() {{
            parentDoc
                .querySelectorAll('textarea[data-testid="stChatInputTextArea"]')
                .forEach(setupInput);
        }}

        function installGlobalButtonCapture() {{
            const globalFlag = '_pasteGlobalCapture_{paste_key}';
            if (parentWindow[globalFlag]) return;

            const globalHandler = function(event) {{
                const target = event.target;
                if (!target || !target.closest) return;

                const submitButton = target.closest(
                    'button[data-testid="stChatInputSubmitButton"], ' +
                    'button[type="submit"]'
                );
                if (!submitButton) return;

                const chatContainer = submitButton.closest(
                    'div[data-testid="stChatInput"]'
                );
                const input = chatContainer
                    ? chatContainer.querySelector(
                        'textarea[data-testid="stChatInputTextArea"]'
                    )
                    : parentDoc.querySelector(
                        'textarea[data-testid="stChatInputTextArea"]'
                    );

                finalizeSubmission(input);
            }};

            parentDoc.addEventListener('pointerdown', globalHandler, true);
            parentDoc.addEventListener('click', globalHandler, true);
            parentWindow[globalFlag] = true;
        }}

        setupAllInputs();
        installGlobalButtonCapture();

        const observer = new MutationObserver(() => {{
            setupAllInputs();
        }});

        observer.observe(parentDoc.body, {{
            childList: true,
            subtree: true
        }});
    }})();
    </script>
    """
    st.iframe(html_code, height=1)

    chat_input = st.chat_input(placeholder=placeholder, key=key, disabled=disabled)

    if chat_input:
        submit_js = f"""
        <script>
        (function() {{
            const parentWindow = window.parent;
            if (
                parentWindow._currentPaste &&
                parentWindow._currentPaste['{paste_key}']
            ) {{
                parentWindow._currentPaste['{paste_key}'].submitted = true;
            }}
        }})();
        </script>
        """
        st.iframe(submit_js, height=1)

        is_pasted = False
        clean_message = chat_input
        typing_trace = []
        trace_version = 1
        trace_truncated = False

        if chat_input.startswith(PASTE_MARKER):
            is_pasted = True
            clean_message = chat_input[len(PASTE_MARKER):]

        if TRACE_PREFIX in clean_message and TRACE_SUFFIX in clean_message:
            prefix_index = clean_message.rfind(TRACE_PREFIX)
            suffix_index = clean_message.find(TRACE_SUFFIX, prefix_index)
            if prefix_index != -1 and suffix_index != -1:
                payload_start = prefix_index + len(TRACE_PREFIX)
                payload = clean_message[payload_start:suffix_index]
                try:
                    bit_stream = "".join(
                        "1" if ch == TRACE_ONE else "0"
                        for ch in payload
                        if ch in (TRACE_ZERO, TRACE_ONE)
                    )
                    six_bit_chunks = [
                        bit_stream[idx:idx + 6]
                        for idx in range(0, len(bit_stream), 6)
                        if len(bit_stream[idx:idx + 6]) == 6
                    ]
                    base64_text = "".join(
                        TRACE_BASE64_ALPHABET[int(chunk, 2)]
                        for chunk in six_bit_chunks
                    )
                    padding = (-len(base64_text)) % 4
                    decoded = base64.b64decode(base64_text + ("=" * padding)).decode(
                        "utf-8"
                    )
                    trace_data = json.loads(decoded)
                    if isinstance(trace_data, dict):
                        raw_trace = trace_data.get("t", [])
                        if isinstance(raw_trace, list):
                            typing_trace = raw_trace
                        trace_version = trace_data.get("v", 1)
                        trace_truncated = bool(trace_data.get("tt", False))
                    clean_message = clean_message[:prefix_index]
                except Exception:
                    pass

        return {
            "message": clean_message,
            "isPasted": is_pasted,
            "typingTrace": typing_trace,
            "traceVersion": trace_version,
            "traceTruncated": trace_truncated,
        }

    return None
