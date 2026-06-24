export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_users: {
        Row: {
          active_workspace_id: string | null
          created_at: string
          email: string | null
          id: string
          is_comped: boolean
          updated_at: string
        }
        Insert: {
          active_workspace_id?: string | null
          created_at?: string
          email?: string | null
          id: string
          is_comped?: boolean
          updated_at?: string
        }
        Update: {
          active_workspace_id?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_comped?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_users_active_workspace_id_fkey"
            columns: ["active_workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_customers: {
        Row: {
          billing_email: string | null
          created_at: string
          gateway_customer_id: string
          gateway_name: string
          workspace_id: string
        }
        Insert: {
          billing_email?: string | null
          created_at?: string
          gateway_customer_id: string
          gateway_name?: string
          workspace_id: string
        }
        Update: {
          billing_email?: string | null
          created_at?: string
          gateway_customer_id?: string
          gateway_name?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_customers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          gateway_customer_id: string
          gateway_name: string
          gateway_subscription_id: string
          plan: string
          status: Database["public"]["Enums"]["subscription_status"]
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          gateway_customer_id: string
          gateway_name?: string
          gateway_subscription_id: string
          plan?: string
          status: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          gateway_customer_id?: string
          gateway_name?: string
          gateway_subscription_id?: string
          plan?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_subscriptions_gateway_customer_id_fkey"
            columns: ["gateway_customer_id"]
            isOneToOne: false
            referencedRelation: "billing_customers"
            referencedColumns: ["gateway_customer_id"]
          },
        ]
      }
      generation_logs: {
        Row: {
          created_at: string
          id: string
          model: string | null
          output_files: Json | null
          prompt: string
          rag_chunk_count: number
          rag_used: boolean
          repair_loops: number | null
          resource_name: string | null
          static_pass: boolean | null
          thread_id: string | null
          user_rating: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          model?: string | null
          output_files?: Json | null
          prompt: string
          rag_chunk_count?: number
          rag_used?: boolean
          repair_loops?: number | null
          resource_name?: string | null
          static_pass?: boolean | null
          thread_id?: string | null
          user_rating?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          model?: string | null
          output_files?: Json | null
          prompt?: string
          rag_chunk_count?: number
          rag_used?: boolean
          repair_loops?: number | null
          resource_name?: string | null
          static_pass?: boolean | null
          thread_id?: string | null
          user_rating?: string | null
        }
        Relationships: []
      }
      mastra_message_embeddings: {
        Row: {
          content: string | null
          created_at: string
          embedding: string
          id: string
          message_id: string | null
          metadata: Json | null
          resource_id: string | null
          thread_id: string | null
          workspace_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          embedding: string
          id: string
          message_id?: string | null
          metadata?: Json | null
          resource_id?: string | null
          thread_id?: string | null
          workspace_id: string
        }
        Update: {
          content?: string | null
          created_at?: string
          embedding?: string
          id?: string
          message_id?: string | null
          metadata?: Json | null
          resource_id?: string | null
          thread_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mastra_message_embeddings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mastra_messages: {
        Row: {
          author_email: string | null
          author_id: string | null
          content: Json
          created_at: string
          id: string
          resource_id: string | null
          role: string
          server_id: string | null
          thread_id: string
          type: string
          workspace_id: string
        }
        Insert: {
          author_email?: string | null
          author_id?: string | null
          content: Json
          created_at?: string
          id: string
          resource_id?: string | null
          role: string
          server_id?: string | null
          thread_id: string
          type?: string
          workspace_id: string
        }
        Update: {
          author_email?: string | null
          author_id?: string | null
          content?: Json
          created_at?: string
          id?: string
          resource_id?: string | null
          role?: string
          server_id?: string | null
          thread_id?: string
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mastra_messages_server_fk"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mastra_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "mastra_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mastra_messages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mastra_observational_memory: {
        Row: {
          created_at: string
          generation_count: number
          id: string
          lookup_key: string
          record: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          generation_count?: number
          id: string
          lookup_key: string
          record: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          generation_count?: number
          id?: string
          lookup_key?: string
          record?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mastra_observational_memory_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mastra_resources: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          updated_at: string
          working_memory: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id: string
          metadata?: Json | null
          updated_at?: string
          working_memory?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          updated_at?: string
          working_memory?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mastra_resources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mastra_threads: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          resource_id: string
          server_id: string | null
          title: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id: string
          metadata?: Json | null
          resource_id: string
          server_id?: string | null
          title?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          resource_id?: string
          server_id?: string | null
          title?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mastra_threads_server_fk"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mastra_threads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      servers: {
        Row: {
          client_server_key: string
          created_at: string
          github_remote_url: string | null
          id: string
          name: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          client_server_key: string
          created_at?: string
          github_remote_url?: string | null
          id?: string
          name?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          client_server_key?: string
          created_at?: string
          github_remote_url?: string | null
          id?: string
          name?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "servers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_counters: {
        Row: {
          usage_count: number
          usage_reset_date: string
          workspace_id: string
        }
        Insert: {
          usage_count?: number
          usage_reset_date: string
          workspace_id: string
        }
        Update: {
          usage_count?: number
          usage_reset_date?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_counters_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_invitations: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          invitee_email: string
          invitee_role: Database["public"]["Enums"]["workspace_member_role"]
          invitee_user_id: string | null
          inviter_user_id: string
          status: Database["public"]["Enums"]["workspace_invitation_status"]
          workspace_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          invitee_email: string
          invitee_role?: Database["public"]["Enums"]["workspace_member_role"]
          invitee_user_id?: string | null
          inviter_user_id: string
          status?: Database["public"]["Enums"]["workspace_invitation_status"]
          workspace_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          invitee_email?: string
          invitee_role?: Database["public"]["Enums"]["workspace_member_role"]
          invitee_user_id?: string | null
          inviter_user_id?: string
          status?: Database["public"]["Enums"]["workspace_invitation_status"]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitations_invitee_user_id_fkey"
            columns: ["invitee_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitations_inviter_user_id_fkey"
            columns: ["inviter_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          added_at: string
          id: string
          role: Database["public"]["Enums"]["workspace_member_role"]
          user_id: string
          workspace_id: string
        }
        Insert: {
          added_at?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_member_role"]
          user_id: string
          workspace_id: string
        }
        Update: {
          added_at?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_member_role"]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          is_personal: boolean
          name: string
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_personal?: boolean
          name: string
          slug?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_personal?: boolean
          name?: string
          slug?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invitation: { Args: { p_invitation_id: string }; Returns: string }
      add_workspace_member: {
        Args: {
          p_role?: Database["public"]["Enums"]["workspace_member_role"]
          p_user_id: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      create_invitation: {
        Args: {
          p_invitee_email: string
          p_role?: Database["public"]["Enums"]["workspace_member_role"]
          p_workspace_id: string
        }
        Returns: string
      }
      create_team_workspace: { Args: { p_name: string }; Returns: string }
      create_workspace: {
        Args: { p_name: string; p_user_id: string }
        Returns: string
      }
      decline_invitation: {
        Args: { p_invitation_id: string }
        Returns: undefined
      }
      ensure_billing_customer: {
        Args: {
          p_customer_id: string
          p_email?: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      ensure_provisioned: { Args: { p_user_id: string }; Returns: string }
      ensure_server: {
        Args: {
          p_client_server_key: string
          p_name?: string
          p_workspace_id: string
        }
        Returns: string
      }
      get_customer_workspace_id: {
        Args: { p_customer: string }
        Returns: string
      }
      get_my_pending_invitations: {
        Args: never
        Returns: {
          created_at: string
          expires_at: string
          id: string
          invitee_role: Database["public"]["Enums"]["workspace_member_role"]
          inviter_email: string
          workspace_id: string
          workspace_name: string
        }[]
      }
      get_subscription: {
        Args: { p_workspace_id?: string }
        Returns: {
          can_generate: boolean
          plan: string
          usage_count: number
          usage_limit: number
          workspace_id: string
        }[]
      }
      get_user_workspace_plan: {
        Args: { p_user_id: string; p_workspace_id?: string }
        Returns: {
          can_generate: boolean
          plan: string
          usage_count: number
          usage_limit: number
          workspace_id: string
        }[]
      }
      get_workspace_members: {
        Args: { p_workspace_id: string }
        Returns: {
          added_at: string
          email: string
          role: Database["public"]["Enums"]["workspace_member_role"]
          user_id: string
        }[]
      }
      increment_usage: { Args: { p_workspace_id: string }; Returns: boolean }
      is_workspace_member: {
        Args: { p_workspace_id: string }
        Returns: boolean
      }
      is_workspace_owner: { Args: { p_workspace_id: string }; Returns: boolean }
      leave_workspace: { Args: { p_workspace_id: string }; Returns: undefined }
      list_my_workspaces: {
        Args: never
        Returns: {
          is_personal: boolean
          name: string
          plan: string
          role: Database["public"]["Enums"]["workspace_member_role"]
          workspace_id: string
        }[]
      }
      mastra_delete_embeddings: {
        Args: { p_ids: string[] }
        Returns: undefined
      }
      mastra_delete_messages: {
        Args: { p_message_ids: string[] }
        Returns: undefined
      }
      mastra_delete_thread: {
        Args: { p_thread_id: string }
        Returns: undefined
      }
      mastra_match_embeddings: {
        Args: {
          match_count?: number
          p_resource_id?: string
          p_thread_id?: string
          p_workspace_id: string
          query_embedding: string
        }
        Returns: {
          content: string
          id: string
          message_id: string
          metadata: Json
          resource_id: string
          similarity: number
          thread_id: string
        }[]
      }
      mastra_om_clear: { Args: { p_lookup_key: string }; Returns: undefined }
      mastra_om_patch: {
        Args: { p_id: string; p_patch: Json }
        Returns: undefined
      }
      mastra_om_upsert: {
        Args: {
          p_generation_count: number
          p_id: string
          p_lookup_key: string
          p_record: Json
          p_workspace_id: string
        }
        Returns: undefined
      }
      mastra_save_messages: { Args: { p_messages: Json }; Returns: undefined }
      mastra_save_resource: {
        Args: {
          p_id: string
          p_metadata?: Json
          p_working_memory?: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      mastra_save_thread: {
        Args: {
          p_metadata?: Json
          p_resource_id: string
          p_server_id?: string
          p_thread_id: string
          p_title?: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      mastra_search_messages: {
        Args: { p_limit?: number; p_query: string; p_resource_id: string }
        Returns: {
          archived_at: string
          snippet: string
          thread_id: string
          title: string
          updated_at: string
        }[]
      }
      mastra_update_messages: { Args: { p_messages: Json }; Returns: undefined }
      mastra_update_resource: {
        Args: { p_id: string; p_metadata?: Json; p_working_memory?: string }
        Returns: undefined
      }
      mastra_update_thread: {
        Args: { p_id: string; p_metadata?: Json; p_title: string }
        Returns: undefined
      }
      mastra_upsert_embeddings: {
        Args: { p_rows: Json; p_workspace_id: string }
        Returns: undefined
      }
      match_ox_corpus: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          similarity: number
          source_type: string
          source_url: string
          text: string
        }[]
      }
      my_workspace_role: { Args: { p_workspace_id: string }; Returns: string }
      next_reset_date: { Args: never; Returns: string }
      personal_workspace_id: { Args: { p_user_id: string }; Returns: string }
      plan_limit: { Args: { p_plan: string }; Returns: number }
      remove_member: {
        Args: { p_user_id: string; p_workspace_id: string }
        Returns: undefined
      }
      revoke_invitation: {
        Args: { p_invitation_id: string }
        Returns: undefined
      }
      set_active_workspace: {
        Args: { p_workspace_id: string }
        Returns: undefined
      }
      set_server_github_remote: {
        Args: {
          p_client_server_key: string
          p_github_remote_url: string
          p_workspace_id: string
        }
        Returns: string
      }
      update_subscription: {
        Args: {
          p_cancel_at_period_end?: boolean
          p_customer_id: string
          p_period_end?: string
          p_period_start?: string
          p_plan?: string
          p_status: Database["public"]["Enums"]["subscription_status"]
          p_subscription_id: string
        }
        Returns: undefined
      }
      workspace_plan: { Args: { p_workspace_id: string }; Returns: string }
    }
    Enums: {
      subscription_status:
        | "trialing"
        | "active"
        | "canceled"
        | "incomplete"
        | "incomplete_expired"
        | "past_due"
        | "unpaid"
        | "paused"
      workspace_invitation_status:
        | "active"
        | "accepted"
        | "declined"
        | "revoked"
      workspace_member_role: "owner" | "admin" | "developer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      subscription_status: [
        "trialing",
        "active",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "past_due",
        "unpaid",
        "paused",
      ],
      workspace_invitation_status: [
        "active",
        "accepted",
        "declined",
        "revoked",
      ],
      workspace_member_role: ["owner", "admin", "developer"],
    },
  },
} as const

