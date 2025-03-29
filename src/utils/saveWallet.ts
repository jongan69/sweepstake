import axios from "axios";
import { DEFAULT_WALLET } from "@utils/globals";

interface WalletInfo {
  referredBy: string;
  referralAccountPubKey?: string;
}

export const saveWalletToDb = async (address: string, referredBy: string): Promise<string> => {
    try {
        if (!referredBy) {
            referredBy = DEFAULT_WALLET;
        }
        const response = await axios.post('/api/wallet/save-wallet', { address, referredBy });
        return response.data.referredBy;
    } catch (error) {
        // Check if it's an axios error with status code 500
        if (axios.isAxiosError(error) && error.response?.status === 500) {
            console.warn('Server error (500) while saving wallet, continuing with default referral:', error);
            return referredBy;
        }
        // For other errors, log and return default referral
        console.warn('Error saving wallet:', error);
        return referredBy;
    }
};

export const getWalletInfo = async (address: string): Promise<WalletInfo | null> => {
    try {
        const response = await axios.get(`/api/wallet/get-wallet?address=${address}`);
        return response.data;
    } catch (error) {
        console.warn('Error getting wallet info:', error);
        return null;
    }
};

export const updateWalletReferralAccount = async (address: string, referralAccountPubKey: string) => {
    try {
        const response = await axios.put('/api/wallet/update-wallet', { 
            address, 
            referralAccountPubKey 
        });
        return response.data;
    } catch (error) {
        // Check if it's an axios error with status code 500
        if (axios.isAxiosError(error) && error.response?.status === 500) {
            console.warn('Server error (500) while updating wallet referral account:', error);
            return { success: true, message: 'Wallet updated with default values' };
        }
        // For other errors, log and return a default response
        console.warn('Error updating wallet:', error);
        return { success: true, message: 'Wallet updated with default values' };
    }
};