const form = document.getElementById("uploadForm");
const passwordInput = document.getElementById("password");
const progressBar = document.getElementById("progress-bar");
const progressContainer = document.getElementById("progress-container");
const customNameInput = document.getElementById("customName");
const notification = document.getElementById("notification");
const status = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");
const videoFileInput = document.getElementById("videoFile");

let sseEventSource = null;

function handleAuthError(errorType, message) {
  passwordInput.classList.remove("input-error");
  passwordInput.classList.add("input-error");
  showNotification(message, true, "auth");
  passwordInput.value = "";
  setTimeout(() => passwordInput.focus(), 100);
  setTimeout(() => passwordInput.classList.remove("input-error"), 3000);
}

function resetFormState() {
  submitBtn.disabled = false;
  submitBtn.innerHTML = "<span>📤 Upload Video</span>";
  progressBar.style.width = "0%";
  progressBar.style.background = "linear-gradient(90deg, #667eea, #764ba2)";
  progressContainer.style.display = "none";
  hideStatus();
  form.reset();
  customNameInput.value = ""; // Clear custom name input
  if (sseEventSource) {
    sseEventSource.close();
    sseEventSource = null;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = videoFileInput.files[0];
  if (!file) {
    showNotification("⚠️ Please select a video file.", true);
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = "<span>⏳ Preparing...</span>";
  progressContainer.style.display = "block";
  progressBar.style.width = "0%";
  progressBar.style.background = "linear-gradient(90deg, #667eea, #764ba2)";
  showStatus("Starting upload...", "processing");
  if (sseEventSource) sseEventSource.close(); // Close any existing SSE connection

  const formData = new FormData();
  formData.append("video", file);

  // Get custom name and append it to formData
  const customName = customNameInput.value.trim();
  if (customName) {
    formData.append("customName", customName);
  }

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/upload", true);
  xhr.setRequestHeader("Authorization", passwordInput.value);

  xhr.upload.onprogress = function (event) {
    if (event.lengthComputable) {
      const percent = (event.loaded / event.total) * 100;
      progressBar.style.width = percent + "%";
      showStatus(`Uploading file... ${Math.round(percent)}%`, "processing");
    }
  };

  xhr.onload = async function () {
    try {
      const response = JSON.parse(xhr.responseText);

      if (xhr.status === 401) {
        if (response.error === "MISSING_PASSWORD")
          handleAuthError("MISSING_PASSWORD", "🔒 Please enter a password");
        else if (response.error === "WRONG_PASSWORD")
          handleAuthError("WRONG_PASSWORD", "❌ Wrong password");
        else handleAuthError("AUTH_ERROR", "🚫 Authentication error");
        showStatus("❌ Authentication failed", "error");
        progressBar.style.background = "#ef4444";
        resetFormState();
        passwordInput.value = xhr.status === 401 ? "" : passwordInput.value;
        submitBtn.disabled = false;
        submitBtn.innerHTML = "<span>📤 Upload Video</span>";
        return;
      }

      if (xhr.status >= 400) {
        showStatus(`Error: ${response.message || "Upload failed"}`, "error");
        showNotification(`❌ ${response.message || "Upload failed"}`, true);
        progressBar.style.background = "#ef4444";
        resetFormState();
        return;
      }

      if (response.success && response.taskId) {
        // If the file was moved directly (special password), just show success and reset
        if (response.message === "Upload received, file moved directly.") {
          showStatus("Upload complete. File moved directly.", "success");
          showNotification(`✅ ${response.message}`);
          progressBar.style.width = "100%";
          progressBar.style.background = "#22c55e";
          await loadVideos(); // Reload videos to show the new one
          setTimeout(() => resetFormState(), 2000);
          return;
        }

        // For normal processing, initialize SSE
        showStatus("Upload complete. Initializing processing...", "processing");
        progressBar.style.width = "100%";

        sseEventSource = new EventSource(
          `/processing-status/${response.taskId}`
        );

        sseEventSource.onmessage = function (event) {
          const progressData = JSON.parse(event.data);

          if (progressData.stage === "probing") {
            showStatus(
              progressData.message || "Analyzing video...",
              "processing"
            );
            progressBar.style.width = "0%";
          } else if (progressData.stage === "probed_success") {
            showStatus(
              progressData.message ||
                "Analysis complete. Starting conversion...",
              "processing"
            );
            progressBar.style.width = "0%";
          } else if (progressData.stage === "processing") {
            progressBar.style.width = (progressData.percent || 0) + "%";
            showStatus(
              progressData.message ||
                `Processing... ${progressData.percent || 0}%`,
              "processing"
            );
          } else if (progressData.stage === "done") {
            showStatus(
              progressData.message || "Video processed successfully!",
              "success"
            );
            showNotification(
              `✅ ${progressData.message || "Video processed successfully!"}`
            );
            progressBar.style.width = "100%";
            progressBar.style.background = "#22c55e";
            sseEventSource.close();
            loadVideos(); // Reload videos to show the new one
            setTimeout(() => resetFormState(), 2000);
          } else if (progressData.stage === "error") {
            showStatus(
              `Error: ${progressData.error || "Processing failed"}`,
              "error"
            );
            showNotification(
              `❌ ${
                progressData.error || "An error occurred during processing."
              }`,
              true
            );
            progressBar.style.background = "#ef4444";
            sseEventSource.close();
            resetFormState();
          }
        };

        sseEventSource.onerror = function () {
          showStatus("Error connecting to processing status updates.", "error");
          showNotification(
            "🔌 Connection error with server for status updates.",
            true
          );
          progressBar.style.background = "#ef4444";
          sseEventSource.close();
          resetFormState();
        };
      } else {
        showStatus("Error: Could not initialize video processing.", "error");
        showNotification(
          `❌ ${response.message || "Failed to start processing."}`,
          true
        );
        progressBar.style.background = "#ef4444";
        resetFormState();
      }
    } catch (parseError) {
      console.error(
        "Parse error:",
        parseError,
        "Response text:",
        xhr.responseText
      );
      showStatus("Error processing server response", "error");
      showNotification("❌ Error processing server response", true);
      progressBar.style.background = "#ef4444";
      resetFormState();
    }
  };

  xhr.onerror = function () {
    showStatus("❌ Connection error during upload", "error");
    showNotification("🔌 Connection error with server", true);
    progressBar.style.background = "#ef4444";
    resetFormState();
  };

  xhr.send(formData);
});

// handleRenameAndFinalize function is removed as renaming is now backend-only

function showStatus(message, type) {
  status.textContent = message;
  status.className = `status-${type}`;
  status.style.display = "block";
}

function hideStatus() {
  status.style.display = "none";
}

function showNotification(msg, isError = false, errorType = null) {
  notification.textContent = msg;
  notification.className = "";
  if (isError) {
    notification.className =
      errorType === "auth" ? "notification-auth-error" : "notification-error";
  } else {
    notification.className = "notification-success";
  }
  notification.style.display = "block";
  setTimeout(() => {
    notification.style.display = "none";
    notification.className = "";
  }, 5000);
}

async function loadVideos() {
  try {
    const res = await fetch("/videos");
    if (!res.ok) {
      throw new Error(`Failed to load videos: ${res.statusText}`);
    }
    const videos = await res.json();
    const container = document.getElementById("videoList");

    if (videos.length === 0) {
      container.innerHTML =
        '<div class="no-videos">📂 No videos uploaded yet</div>';
      return;
    }

    container.innerHTML = "";

    videos.forEach((video) => {
      const videoItem = document.createElement("div");
      videoItem.className = "video-item";

      const thumbnailDiv = document.createElement("div");
      thumbnailDiv.className = "video-thumbnail";

      // Create play overlay
      const playOverlay = document.createElement("div");
      playOverlay.className = "play-overlay";
      playOverlay.innerHTML = "▶️";

      if (video.thumbnail) {
        // Show thumbnail image
        const thumbnailImg = document.createElement("img");
        thumbnailImg.src = `/thumbnail/${encodeURIComponent(video.thumbnail)}`;
        thumbnailImg.alt = `Thumbnail for ${video.filename}`;
        thumbnailImg.onerror = function () {
          // Fallback if thumbnail fails to load
          this.style.display = "none";
          const placeholder = document.createElement("div");
          placeholder.className = "placeholder";
          placeholder.textContent = "🎬";
          thumbnailDiv.appendChild(placeholder);
        };
        thumbnailDiv.appendChild(thumbnailImg);
      } else {
        // Show placeholder
        const placeholder = document.createElement("div");
        placeholder.className = "placeholder";
        placeholder.textContent = "🎬";
        thumbnailDiv.appendChild(placeholder);
      }

      thumbnailDiv.appendChild(playOverlay);

      const videoInfo = document.createElement("div");
      videoInfo.className = "video-info";

      const videoLink = document.createElement("a");
      videoLink.href = `/video/${encodeURIComponent(video.filename)}`;
      videoLink.target = "_blank";
      videoLink.className = "video-title";
      videoLink.textContent = video.filename;

      videoInfo.appendChild(videoLink);

      // Make entire video item clickable
      videoItem.addEventListener("click", (e) => {
        if (e.target.tagName !== "A") {
          videoLink.click();
        }
      });

      videoItem.appendChild(thumbnailDiv);
      videoItem.appendChild(videoInfo);
      container.appendChild(videoItem);
    });
  } catch (error) {
    console.error("Error loading videos:", error);
    showNotification(`❌ Error loading video list: ${error.message}`, true);
  }
}

// Load videos on page load
loadVideos();
