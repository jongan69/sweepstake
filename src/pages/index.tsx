import type { NextPage } from "next";
import Head from "next/head";
import React from "react";
import { Header } from "@components/layout/header";
import { PageContainer } from "@components/layout/page-container";
import { HomeContent } from "@components/home/home-content";
import { Footer } from "@components/layout/footer";
import Script from 'next/script'

const Home: NextPage = () => {
  return (
    <>
      <Script
        async
        src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6202902142885850"
        crossOrigin="anonymous"
      />
      <Head>
        <title>Sweepstake</title>
        <meta
          name="description"
          content="Sweep your tokens for SOL"
        />

      </Head>
      <PageContainer>
        <Header />
        <div className="max-w-3xl mx-auto text-center space-y-8">
          <h2 className="text-5xl font-bold mb-4">
            It&apos;s time to {" "}
            <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
              SWEEP YOUR TOKENS FOR SOL
            </span>{" "}
          </h2>
          <p className="text-xl text-base-content/80 mb-8">
            Choose tokens you&apos;d like to convert to SOL
          </p>
          <HomeContent />
        </div>
        <Footer />
      </PageContainer>
    </>
  );
};

export default Home;
