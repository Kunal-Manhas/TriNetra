# Project Trinetra 👁️

**Trinetra** is a proactive geospatial intelligence platform designed to redefine urban safety. Unlike traditional navigation tools that prioritize the *fastest* route, Trinetra leverages intelligence-led algorithms to prioritize the **safest** path. 

Powered by the custom **ShadowGrid** rendering engine, the platform integrates real-time OSINT, predictive modeling, and high-performance spatial queries to provide users with unparalleled situational awareness.

---

## 🚀 Key Features

* **Intelligence-Led Routing:** A custom routing algorithm that analyzes OpenStreetMap (OSM) data via the Overpass API, weighting paths based on safety metrics rather than just distance.
* **ShadowGrid Engine:** A high-performance grid-rendering engine designed for real-time visualization of threat maps and risk zones.
* **Proactive Proximity Alerts:** Real-time push notifications and alerts when a user enters a high-risk area or deviates from a safe path.
* **OSINT Integration:** Live hazard detection by aggregating open-source intelligence and public safety data feeds.
* **Predictive Patrol Modeling:** An advanced feature set designed for law enforcement to visualize heatmaps and optimize patrol routes based on historical incident data.

---

## 🛠️ Technical Architecture

Trinetra is built on a high-concurrency, distributed architecture:

* **Frontend:** React.js & Tailwind CSS (Tech-Noir/Cyber-Tech Aesthetic)
* **Backend:** Node.js & Express.js for core logic; **FastAPI** for high-speed data processing.
* **Database:** * **PostgreSQL with PostGIS:** For complex, high-performance geospatial and topographical queries.
    * **Redis:** For real-time location caching and session management.
* **Data Sources:** OpenStreetMap (OSM) via Overpass API for map data and live OSINT feeds.

---

## 📦 Installation & Setup

### Prerequisites
* Node.js (v18+)
* Python 3.10+ (for FastAPI services)
* PostgreSQL with PostGIS extension installed

### 1. Clone the Repository
bash
git clone [https://github.com/Kunal-Manhas/trinetra.git](https://github.com/Kunal-Manhas/trinetra.git)
cd trinetra

2. Backend Setup (Node.js & FastAPI)
# Setup Node.js backend
cd backend
npm install
npm start

# Setup FastAPI service
cd ../services/intelligence
pip install -r requirements.txt
uvicorn main:app --reload

3. Frontend Setup

cd ../frontend
npm install
npm start


