# FlowTrace
**Wallet Risk Intelligence for Law Enforcement Investigators**

FlowTrace is a prototype web application that provides a highly visual, enterprise-grade dashboard for investigators to rapidly assess cryptocurrency wallet risk, trace transaction flows, and generate case-ready reports—all without requiring deep blockchain expertise.

> **Note**: This is a frontend prototype and interactive demo. It uses mock data for wallet profiles to demonstrate the investigative workflow and is not currently connected to live blockchain nodes.

## Key Features

* **Wallet Risk Scoring**: Instantly evaluate wallet severity with a 0-100 color-coded gauge (Green, Amber, Red).
* **Interactive Transaction Flow Graph**: Visualize fund movements across linked wallets using an interactive node-based canvas graph.
* **AI Investigative Assistant**: Embedded AI chat panel that answers questions about the wallet's risk factors in plain English.
* **One-Click Investigation Reports**: Generate structured, shareable case summaries ready for internal review and documentation.
* **Enterprise Dark Theme**: Designed with the visual language of professional blockchain-intelligence SaaS platforms to reduce eye strain and maintain focus.

## Tech Stack

* **Frontend**: Vanilla HTML5, CSS3, and JavaScript. No heavy frontend frameworks to ensure rapid loading and simple deployment.
* **Backend**: Node.js and Express.js proxy server.
* **AI Integration**: OpenRouter API proxying (Anthropic Claude / Google Gemini) for the natural-language assistant.

## Getting Started

Follow these steps to run the FlowTrace dashboard locally on your machine.

### Prerequisites

* Node.js (v16 or higher)
* An OpenRouter API Key (for the AI assistant features)

### Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/MrPenguin8847/CRTF.git
   cd CRTF
   ```

2. **Install backend dependencies:**
   Navigate to the backend folder and install the required npm packages.
   ```bash
   cd backend
   npm install
   ```

3. **Configure Environment Variables:**
   In the `backend/` directory, create a `.env` file and add your OpenRouter API key:
   ```env
   OPENROUTER_API_KEY=your_api_key_here
   PORT=3000
   ```

4. **Start the Server:**
   ```bash
   npm start
   ```

5. **Open the App:**
   Visit `http://localhost:3000` in your web browser.

## Using the Demo

Once the app is running, use one of the pre-configured mock wallet addresses on the search screen to see the dashboard in action:

* `0x7fC2a9B4d8E1c6A3f0D5b7E9a1C4d6F8b2E0a3C7` (High Risk)
* `0xC4e7A1d9F2b6c8E0a5D3f7B1c9A4e6D8b0F2a7C1`
* `0x9aD3f6C1b8E4a0F7d2C5b9E1a6D8c3F0b4A7e2D5`
* `0xE1b5C9a2F7d3A8c0B6e4D1f9A3c7E2b5D8f0a6C4`
* `0xA6d0F3b8C1e7D4a9F2c5B0e6D8a1C7f4B9d3E0a2`

## Project Status

FlowTrace is a proof-of-concept prototype demonstrating how modern UI/UX and LLM integrations can lower the barrier to entry for digital forensics investigations.
