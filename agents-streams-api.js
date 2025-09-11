'use strict';
const fetchJsonFile = await fetch('./api.json');
const DID_API = await fetchJsonFile.json();
if (DID_API.key == '🤫') alert('Please put your api key inside ./api.json and restart..');


// Set your Agent ID.
// In D-ID Studio: open your agent → Embed settings → copy the value of `data-agent-id` and paste it below.
// You can also create an Agent via API: POST /agents.) Docs: https://docs.d-id.com/reference/createagent
let agentId = '';


// ===== DOM refs and states =====
const videoWrapper = document.getElementById('video-wrapper');
const idleVideo = document.getElementById('idleVideoElement');
const streamVideo = document.getElementById('streamVideoElement');
const connectButton = document.getElementById('connectButton');
const textArea = document.getElementById('textArea');
const interruptButton = document.getElementById('interruptButton');
const previewName = document.getElementById('previewName');
const connectionLabel = document.getElementById('connectionLabel');
const answers = document.getElementById('answers');
const actionButton = document.getElementById('actionButton');
const speechButton = document.getElementById('speechButton');
const container = document.getElementById('container');
const hiddenDiv = document.getElementById('hidden');
const hiddenH2 = document.getElementById('hidden_h2');

let peerConnection = null;
let streamId = null;
let sessionId = null;
let chatId = null;
let isFluent = false; // set from stream session 'fluent' flag
let isStreamReady = false;
let isStreamPlaying = false;
let currentVideoId = null;

// ===== Helper Functions =====
async function fetchWithRetry(url, options, retries = 3) {
    try {
        const res = await fetch(url, options);
        if (!res.ok && retries > 0) {
            console.warn('Fetch failed, retrying...', url);
            await new Promise((r) => setTimeout(r, (Math.random() + 1) * 1000));
            return fetchWithRetry(url, options, retries - 1);
        }
        return res;
    } catch (err) {
        if (retries > 0) {
            console.warn('Fetch error, retrying...', url);
            await new Promise((r) => setTimeout(r, (Math.random() + 1) * 1000));
            return fetchWithRetry(url, options, retries - 1);
        }
        throw err;
    }
}
function updateVideoDisplay(stream, isPlaying) {
    console.log('Updating video display. Playing:', isPlaying);
    if (!isFluent) {
        const streamOpacity = isPlaying && isStreamReady ? 1 : 0;
        idleVideo.style.opacity = 1 - streamOpacity;
        streamVideo.style.opacity = streamOpacity;
        if (isPlaying && stream) {
            streamVideo.srcObject = stream;
            streamVideo.muted = !isStreamReady;
            if (streamVideo.paused) streamVideo.play().catch(() => { });
        }
        // Ensure UI is usable for talk avatars as soon as we have media or connection is ready
        if (isStreamReady) {
            connectionLabel.innerHTML = 'Connected';
            actionButton.removeAttribute('disabled');
            speechButton.removeAttribute('disabled');
        }
    } else {
        idleVideo.style.opacity = 0;
        streamVideo.style.opacity = 1;
        streamVideo.muted = false;
        if (isPlaying && isStreamReady) {
            connectionLabel.innerHTML = 'Connected';
            actionButton.removeAttribute('disabled');
            speechButton.removeAttribute('disabled');
        } else {
            connectionLabel.innerHTML = '';
            actionButton.setAttribute('disabled', true);
            speechButton.setAttribute('disabled', true);
        }
    }
}
function stopStream() {
    // console.log('Stopping video stream...');
    const stream = streamVideo.srcObject;
    if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamVideo.srcObject = null;
    }
}
function closeConnection() {
    // console.log('Closing peer connection...');
    if (!peerConnection) return;
    try { peerConnection.close(); } catch { }
    peerConnection = null;
    isStreamReady = false;
    isStreamPlaying = false;
}
function switchModes() {
    const options = document.querySelectorAll('#buttons input[name="option"]');
    const checkedIndex = Array.from(options).findIndex((opt) => opt.checked);
    options[(checkedIndex + 1) % options.length].checked = true;
}
async function handleAction() {
    const selectedOption = document.querySelector('input[name="option"]:checked')?.value;
    if (selectedOption === 'chat') return chat();
    if (selectedOption === 'speak') return speak();
}

// ===== Main Functions =====
async function connect() {
    console.log('Connecting to Agent...');
    hiddenDiv.style.display = 'none';
    container.style.display = 'flex';
    connectionLabel.textContent = 'Connecting…';
    actionButton.disabled = true;
    speechButton.disabled = true;

    if (peerConnection?.connectionState === 'connected') return;
    // Clean up any existing connections or streams
    stopStream();
    closeConnection();

    // 1) Fetch Agent info
    console.log('Fetching agent info...');
    const resAgent = await fetch(`${DID_API.url}/agents/${agentId}`, {
        method: 'GET',
        headers: { Authorization: `Basic ${DID_API.key}`, 'Content-Type': 'application/json' }
    });
    if (!resAgent.ok) throw new Error(`Failed to fetch agent info: ${resAgent.status} ${resAgent.statusText}`);
    const agentData = await resAgent.json();

    previewName.innerText = agentData.preview_name;
    hiddenH2.innerText = `${agentData.preview_name} Disconnected`;
    console.log('Agent loaded:', agentData);

    // 2) Create Agent's Chat session
    console.log('Creating chat session...');
    const resChat = await fetch(`${DID_API.url}/agents/${agentId}/chat`, {
        method: 'POST',
        headers: { Authorization: `Basic ${DID_API.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ persist: true })
    });
    if (!resChat.ok) throw new Error(`Failed to create chat: ${resChat.status} ${resChat.statusText}`);
    const chatData = await resChat.json();
    chatId = chatData.id;
    console.log('Chat session created:', chatId);

    // Create a new stream
    console.log('Creating stream session...');
    const streamOptions = { compatibility_mode: 'on', fluent: true };
    const resStream = await fetchWithRetry(`${DID_API.url}/agents/${agentId}/streams`, {
        method: 'POST',
        headers: { Authorization: `Basic ${DID_API.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(streamOptions)
    });
    if (!resStream.ok) throw new Error(`Failed to create stream: ${resStream.status} ${resStream.statusText}`);
    const { id, session_id, offer, ice_servers, fluent } = await resStream.json();
    streamId = id;
    sessionId = session_id;
    isFluent = !!fluent;
    console.log('Stream created: ', streamId, '\nFluent mode:', isFluent);

    if (!isFluent) {
        // Prep idle visuals for talk (non-fluent) avatars
        videoWrapper.style.backgroundImage = `url(${agentData.presenter.thumbnail})`;
        idleVideo.src = agentData.presenter.idle_video;
    }

    // Start the WebRTC connection and submit network info (asynchronously)
    console.log('Setting up WebRTC connection...');
    const RTCPeerConnectionCtor =
        window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
    peerConnection = new RTCPeerConnectionCtor({ iceServers: ice_servers });

    // Submit Network information (ICE candidates → API)
    peerConnection.addEventListener('icecandidate', (event) => {
        const body = event.candidate
            ? { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex }
            : {};
        fetch(`${DID_API.url}/agents/${agentId}/streams/${streamId}/ice`, {
            method: 'POST',
            headers: { Authorization: `Basic ${DID_API.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, ...body })
        });
        console.log('ICE candidate sent');
    });

    // Connection state changes
    peerConnection.addEventListener('connectionstatechange', () => {
        console.log('Peer connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'connecting') {
            connectionLabel.innerHTML = 'Connecting…';
        }
        if (peerConnection.connectionState === 'connected') {
            setTimeout(() => {
                if (!isStreamReady) isStreamReady = true;
                // For non-fluent (talk) avatars, enable controls on connect
                if (!isFluent) {
                    connectionLabel.innerHTML = 'Connected';
                    actionButton.removeAttribute('disabled');
                    speechButton.removeAttribute('disabled');
                }
            }, 300);
        }
        if (peerConnection.connectionState === 'disconnected') {
            document.querySelector('#hidden').style.display = 'flex';
            document.querySelector('#container').style.display = 'none';
            actionButton.setAttribute('disabled', true);
            speechButton.setAttribute('disabled', true);
        }
        if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
            stopStream();
            closeConnection();
        }
    });

    // Remote media → <video> + simple “playing” detection
    peerConnection.addEventListener('track', (event) => {
        console.log('Remote track received');
        const stream = event.streams[0];
        const [track] = stream.getVideoTracks();
        if (!track) return;

        streamVideo.srcObject = stream;
        streamVideo.muted = !isStreamReady;

        let lastBytes = 0;
        const interval = setInterval(async () => {
            if (!peerConnection || peerConnection.connectionState === 'closed') {
                clearInterval(interval);
                return;
            }
            try {
                const receiver = peerConnection.getReceivers().find((r) => r.track === track);
                if (!receiver) return;
                const stats = await receiver.getStats();
                stats.forEach((report) => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        const nowPlaying = report.bytesReceived > lastBytes;
                        if (nowPlaying !== isStreamPlaying) {
                            isStreamPlaying = nowPlaying;
                            console.log('Stream playing state changed:', isStreamPlaying);
                            updateVideoDisplay(stream, isStreamPlaying);
                        }
                        lastBytes = report.bytesReceived;
                    }
                });
            } catch { }
        }, 400);
    });

    // Data channel - Chat Answers, Fluent + Interrupt (Only for Premium+ Agents)
    const dc = peerConnection.createDataChannel('JanusDataChannel');
    dc.onmessage = (event) => {
        let msg = event.data;
        if (msg.includes('chat/answer')) {
            msg = decodeURIComponent(msg.replace('chat/answer:', ''));
            console.log('Agent:', msg);
            answers.innerHTML += `<div class='agentMessage'> ${msg}</div><br>`;
            answers.scrollTo({ top: answers.scrollHeight + 50, behavior: 'smooth' });
        }
        if (msg.includes('stream/started')) {
            console.log(msg)
            if (isFluent) {
                const m = msg.match(/{.*}/);
                if (m) {
                    const data = JSON.parse(m[0]);
                    currentVideoId = data.metadata.videoId;
                    interruptButton.style.display = 'inline-flex';
                    speechButton.style.display = 'none';
                    actionButton.style.display = 'none';
                }
            }

        }
        if (msg.includes('stream/done')) {
            console.log(msg)
            if (isFluent) {
                currentVideoId = null;
                interruptButton.style.display = 'none';
                speechButton.style.display = 'inline-flex';
                actionButton.style.display = 'inline-flex';
            }
        }
    };
    
// Interrupt Button logic
    interruptButton.onclick = () => {
        if (!currentVideoId) return;
        console.log('Interrupting video', currentVideoId);
        dc.send(JSON.stringify({ type: 'stream/interrupt', videoId: currentVideoId, timestamp: Date.now() }));
        interruptButton.style.display = 'none';
        speechButton.style.display = 'inline-flex';
        actionButton.style.display = 'inline-flex';
    };

    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    // Send SDP answer (Start a WebRTC connection endpoint)
    console.log('Sending local SDP answer...');
    await fetch(`${DID_API.url}/agents/${agentId}/streams/${streamId}/sdp`, {
        method: 'POST',
        headers: { Authorization: `Basic ${DID_API.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer, session_id: sessionId })
    });
}
async function chat() {
    if (!peerConnection || !isStreamReady) return;
    const val = textArea.value.trim();
    if (!val) return;
    textArea.value = '';
    console.log('Sending chat text:', val);
    answers.innerHTML += `<div class='userMessage'> ${val}</div><br>`;
    answers.scrollTo({ top: answers.scrollHeight + 50, behavior: 'smooth' });
    const payload = {
        messages: [{ content: val, role: 'user', created_at: new Date().toISOString() }],
        streamId,
        sessionId
    };
    await fetch(`${DID_API.url}/agents/${agentId}/chat/${chatId}`, {
        method: 'POST',
        headers: { Authorization: `Basic ${DID_API.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}
async function speak() {
    if (!peerConnection || !isStreamReady) return;
    const val = textArea.value.trim();
    if (!val) return;
    textArea.value = '';
    console.log('Sending speak text:', val);
    answers.innerHTML += `<div class='agentMessage'> ${val}</div><br>`;
    answers.scrollTo({ top: answers.scrollHeight + 50, behavior: 'smooth' });
    await fetchWithRetry(`${DID_API.url}/agents/${agentId}/streams/${streamId}`, {
        method: 'POST',
        headers: { Authorization: `Basic ${DID_API.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: { type: 'text', input: val }, session_id: sessionId })
    });
}

// On page load actions
(async function onPageLoad() {

    // Focus text area and disable action buttons until connected
    textArea.focus();
    actionButton.setAttribute('disabled', true);
    speechButton.setAttribute('disabled', true);

    // Add event listeners to DOM elements
    textArea.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); handleAction(); }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') { event.preventDefault(); switchModes(); }
    });
    connectButton.addEventListener('click', () => connect());
    actionButton.addEventListener('click', handleAction);
    speechButton.addEventListener('click', () => toggleStartStop?.());

    // Auto-connect for demo
    connectButton.click();
})();
