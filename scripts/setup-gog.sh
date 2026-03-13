#!/usr/bin/env bash
set -euo pipefail

MODE="full"
PROJECT_ID=""
USER_EMAIL=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable-apis) MODE="enable-apis"; shift ;;
    --help|-h)
      echo "Usage: setup-gog.sh [options] [project-id] [user-email]"
      echo ""
      echo "Options:"
      echo "  --enable-apis  Only enable/disable APIs on an existing project"
      echo "  --help         Show this help"
      echo ""
      echo "Examples:"
      echo "  setup-gog.sh                       # Full setup with default project 'gog-cli'"
      echo "  setup-gog.sh my-project             # Full setup with custom project ID"
      echo "  setup-gog.sh --enable-apis my-proj  # Add APIs to existing project"
      exit 0
      ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *) [[ -z "$PROJECT_ID" ]] && PROJECT_ID="$1" || USER_EMAIL="$1"; shift ;;
  esac
done

# --- Preflight checks ---

# gcloud CLI
if ! command -v gcloud &>/dev/null; then
  echo "Error: gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Auth check — prompt login if not authenticated
ACTIVE_ACCOUNT=$(gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null || true)
if [[ -z "$ACTIVE_ACCOUNT" ]]; then
  echo ">>> No active gcloud account found. Launching login..."
  gcloud auth login
  ACTIVE_ACCOUNT=$(gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null)
  if [[ -z "$ACTIVE_ACCOUNT" ]]; then
    echo "Error: gcloud login failed."
    exit 1
  fi
fi
echo "Authenticated as: $ACTIVE_ACCOUNT"

# Generate default project ID from account email if not specified
if [[ -z "$PROJECT_ID" ]]; then
  SUFFIX=$(echo -n "$ACTIVE_ACCOUNT" | openssl dgst -sha256 -hex | sed 's/.*= //' | head -c 8)
  PROJECT_ID="gog-cli-${SUFFIX}"
fi

# Available APIs — name:service_id
AVAILABLE_APIS=(
  "Gmail:gmail.googleapis.com"
  "Google Calendar:calendar-json.googleapis.com"
  "Google Chat:chat.googleapis.com"
  "Google Drive:drive.googleapis.com"
  "Google Classroom:classroom.googleapis.com"
  "People (Contacts):people.googleapis.com"
  "Google Tasks:tasks.googleapis.com"
  "Google Sheets:sheets.googleapis.com"
  "Google Forms:forms.googleapis.com"
  "Apps Script:script.googleapis.com"
  "Cloud Identity (Groups):cloudidentity.googleapis.com"
)

# Interactive checkbox selection using arrow keys and space
select_apis() {
  local enabled_raw="${1:-}"
  local count=${#AVAILABLE_APIS[@]}
  local selected=()
  local cursor=0

  # Initialize selection based on already-enabled APIs (or all if no info)
  for ((i = 0; i < count; i++)); do
    local svc="${AVAILABLE_APIS[$i]#*:}"
    if [[ -z "$enabled_raw" ]]; then
      selected[$i]=1
    elif echo "$enabled_raw" | grep -q "^${svc}$"; then
      selected[$i]=1
    else
      selected[$i]=0
    fi
  done

  # Hide cursor and set up cleanup
  tput civis 2>/dev/null || true
  trap 'tput cnorm 2>/dev/null; tput sgr0 2>/dev/null' EXIT

  render() {
    # Move cursor to top of list
    if [[ ${1:-} == "redraw" ]]; then
      tput cuu "$count" 2>/dev/null || true
    fi
    for ((i = 0; i < count; i++)); do
      local name="${AVAILABLE_APIS[$i]%%:*}"
      local check=" "
      [[ ${selected[$i]} -eq 1 ]] && check="x"
      if [[ $i -eq $cursor ]]; then
        printf "\r  \033[7m [%s] %s \033[0m\033[K\n" "$check" "$name"
      else
        printf "\r   [%s] %s\033[K\n" "$check" "$name"
      fi
    done
  }

  echo ""
  echo "Select APIs to enable (↑↓: move, space: toggle, a: all/none, enter: confirm):"
  echo ""
  render

  while true; do
    # Read a single keypress
    IFS= read -rsn1 key
    case "$key" in
      # Arrow key escape sequence
      $'\x1b')
        read -rsn2 seq
        case "$seq" in
          '[A') ((cursor > 0)) && ((cursor--)) ;;           # Up
          '[B') ((cursor < count - 1)) && ((cursor++)) ;;   # Down
        esac
        ;;
      # Space — toggle current item
      ' ')
        selected[$cursor]=$(( 1 - selected[$cursor] ))
        ;;
      # 'a' — toggle all
      a|A)
        local any_on=0
        for ((i = 0; i < count; i++)); do
          [[ ${selected[$i]} -eq 1 ]] && any_on=1 && break
        done
        local new_val=$(( 1 - any_on ))
        for ((i = 0; i < count; i++)); do
          selected[$i]=$new_val
        done
        ;;
      # Enter — confirm
      '')
        break
        ;;
    esac
    render redraw
  done

  # Restore cursor
  tput cnorm 2>/dev/null || true

  SELECTED_APIS=()
  for ((i = 0; i < count; i++)); do
    if [[ ${selected[$i]} -eq 1 ]]; then
      SELECTED_APIS+=("${AVAILABLE_APIS[$i]#*:}")
    fi
  done

  if [[ ${#SELECTED_APIS[@]} -eq 0 ]]; then
    echo "No APIs selected. Exiting."
    exit 1
  fi

  echo ""
  echo "  ${#SELECTED_APIS[@]} APIs selected."
}

echo "=== gog CLI — Google Cloud Setup ==="
echo "Project ID: $PROJECT_ID"

if [[ "$MODE" == "enable-apis" ]]; then
  # Enable APIs only mode — query already-enabled APIs and pre-check them
  echo ">>> Fetching currently enabled APIs..."
  gcloud config set project "$PROJECT_ID" 2>/dev/null
  ENABLED_RAW=$(gcloud services list --enabled --format="value(config.name)" 2>/dev/null)

  select_apis "$ENABLED_RAW"

  echo ">>> Enabling ${#SELECTED_APIS[@]} APIs..."
  gcloud services enable "${SELECTED_APIS[@]}"

  echo ""
  echo "=== Done ==="
  exit 0
fi

# --- Full setup ---

# Select APIs
select_apis

# Create project
echo ">>> Creating project..."
gcloud projects create "$PROJECT_ID" --name="gog CLI" 2>/dev/null || echo "Project already exists"
gcloud config set project "$PROJECT_ID"

# Enable selected APIs
echo ">>> Enabling ${#SELECTED_APIS[@]} APIs..."
gcloud services enable "${SELECTED_APIS[@]}"

# Helper: open URL in browser
open_url() {
  if command -v open &>/dev/null; then
    open "$1"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$1"
  fi
}

if [ -z "$USER_EMAIL" ]; then
  USER_EMAIL=$(gcloud config get-value account 2>/dev/null)
fi

# --- Step 1: OAuth consent screen ---
echo ""
echo ">>> Step 1/3: Configure OAuth consent screen"
echo ""
echo "    A browser window will open. Fill in the following:"
echo ""
echo "    1. App name         → gog CLI  (or any name you like)"
echo "    2. User support email → $USER_EMAIL"
echo "    3. Audience          → External"
echo "    4. Click 'Create' or 'Save'"
echo ""
CONSENT_URL="https://console.cloud.google.com/auth/branding?project=$PROJECT_ID"
open_url "$CONSENT_URL"
echo "    Opening: $CONSENT_URL"

echo ""
read -rp "    Press Enter when done: "

# --- Step 2: Add test user ---
echo ""
echo ">>> Step 2/3: Add test user"
echo ""
echo "    1. Click '+ Add users'"
echo "    2. Enter your email: $USER_EMAIL"
echo "    3. Click 'Save'"
echo ""
AUDIENCE_URL="https://console.cloud.google.com/auth/audience?project=$PROJECT_ID"
open_url "$AUDIENCE_URL"
echo "    Opening: $AUDIENCE_URL"
echo ""
read -rp "    Press Enter when done: "

# --- Step 3: Create OAuth Desktop client ---
echo ""
echo ">>> Step 3/3: Create OAuth Desktop client"
echo ""
echo "    1. Click 'Create Client'"
echo "    2. Application type → select 'Desktop app'"
echo "    3. Name             → gog Desktop  (or any name)"
echo "    4. Click 'Create'"
echo "    5. Click 'Download JSON' to save the client secret file"
echo ""
CLIENT_URL="https://console.cloud.google.com/auth/clients?project=$PROJECT_ID"
open_url "$CLIENT_URL"
echo "    Opening: $CLIENT_URL"
echo ""
read -rp "    Press Enter when done: "

echo ""
echo "=== Google Cloud setup complete ==="
echo ""
echo ">>> Next steps: Configure gog CLI"
echo ""
echo "    1. Install gog CLI (if not already installed):"
echo "       brew install steipete/tap/gogcli"
echo ""
echo "    2. Register your OAuth credentials:"
echo "       gog auth credentials ~/Downloads/client_secret_*.json"
echo ""
echo "    3. Authorize your Google account:"
echo "       gog auth add $USER_EMAIL"
echo ""
echo "    4. (Optional) Limit to specific services:"
echo "       gog auth add $USER_EMAIL --services drive,calendar,gmail"
echo ""
echo "    5. Test it:"
echo "       export GOG_ACCOUNT=$USER_EMAIL"
echo "       gog gmail labels list"
echo ""
echo "    6. Register with GeminiClaw:"
echo "       geminiclaw setup --step gog"
